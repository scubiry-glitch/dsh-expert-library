/**
 * Task-completion quality gate tests (architecture gap #1): `expert_teams_update_task`
 * must evaluate the applicable quality chain when a task transitions to `completed`.
 *
 * Covers the shared pure core that the tool wiring runs (see `src/task-gates.ts`):
 * - zhijian plan gate chain (compliance-anonymization + data-citation bound to the
 *   fusion task t2) blocks a completion whose output leaks a real expert identity
 *   (已故专家 bk-022 顾云昌 / 非已故 陶琦), with the correction guidance;
 * - retry after fixing the output succeeds;
 * - data-citation blocks uncited numbers and passes once a 来源/口径 marker is added;
 * - soft-gate warnings attach to the result (and would land on `TeamTask.gateWarnings`);
 * - ad-hoc teams (no plan, no scenario) and legacy-scenario teams (empty legacy policy)
 *   are unaffected — the evaluation returns undefined, i.e. today's behavior;
 * - the repair-round budget is honored across attempts (0→blocked, 1→blocked, 2→
 *   allowed with a recorded warning, per the zhijian policy's maxRepairRounds = 2);
 * - the blocked error message carries the gate id and the correction text;
 * - deliverable-targeted gates compose every source task output once all sources
 *   are complete;
 * - the derived 0–100 aggregate score (`deriveQualityScore`: hard all pass =
 *   80 + soft pass ratio ×20; hard fail = low band 0–59 by pass ratio) lands
 *   in the task title as 「质 NN」/「质 NN·硬门未过」,
 *   idempotently replacing any previous marker (no stacking);
 * - forced recovery: `quality_score`/`repair_count` are always present in the
 *   tool result, `output/result.json` and `TeamTask` (null/0 for no-policy
 *   teams), even when the member output never mentions them, and repair_count
 *   increments across blocked retries;
 * - output-schema enforcement: when the policy declares schema-structure and
 *   the task binds a resolvable output-template contract, the injected
 *   schema-structure gate blocks outputs missing required sections (or invalid
 *   JSON) with correction guidance; legacy/collab/ad-hoc teams get no
 *   injection;
 * - `stampQualityPlan` round-trips through the durable team record.
 *
 * All hermetic: pure core functions against in-memory/temp-dir fixtures, no network,
 * no model calls. Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  QUALITY_BASE_SCORE,
  QUALITY_HARD_FAIL_MAX,
  QUALITY_SOFT_WEIGHT,
  deriveQualityScore,
  evaluateTaskCompletionGates,
  stampQualityPlan,
  subjectWithQualityMark,
  taskGateBlockedError,
  zhijianComplianceTerms,
} from '../lib/task-gates.js'
import { readTeam } from '../lib/state.js'
import { registerExpertTeamsTools } from '../lib/tools.js'
import { compileExecutionPlan, buildZhijianDomainPack } from '../lib/v2/index.js'

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/** Compile the real zhijian framework-A plan (reviewers + fusion task). */
function zhijianPlan(selectedExpertIds = ['bk-024']) {
  const result = compileExecutionPlan({
    pack: buildZhijianDomainPack(),
    templateId: 'zhijian.team.A',
    scenarioId: 'zhijian-monthly',
    params: {
      selectedExpertIds,
      data: '上海 2026-07 二手房市场',
      dataContext: '数据本体：上海 2026-07 二手房市场\n数据来源：贝壳\n城市/区域：上海\n数据时段：2026-07',
      frameworkName: '五维递进',
      frameworkSteps: '1. 一句话定性\n2. 指标解读',
      frameworkConstraints: '1. 结论先行\n2. 数字带口径',
      wordLimitLine: '\n字数约束：约 500 字 ±10%',
      frameworkWordLimitParen: '（约 500 字 ±10%）',
      outputFormText: '讨论稿',
      fusionExtraRules: '5. 数字必须核实',
      outputForm: 'discussion',
    },
  })
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  return result.ok ? result.plan : undefined
}

/** Minimal durable team record built from a compiled plan's stamp. */
function teamFixture(plan, overrides = {}) {
  return {
    id: 'team-gate',
    name: '门控团队',
    captainSessionId: 'sess-captain',
    createdAt: 1,
    scenarioId: plan.scenario?.id,
    planRef: {
      planId: plan.planId,
      digest: plan.digest,
      templateId: plan.template.id,
      templateVersion: plan.template.version,
    },
    qualityPlan: stampQualityPlan(plan),
    members: [{ id: 'sess-member', name: '成员甲', joinedAt: 1, status: 'idle' }],
    tasks: [
      { id: 't1', subject: '专家研判', status: 'completed', dependencies: [], output: '## 研判\n上海二手房市场筑底迹象明显。', createdAt: 1, updatedAt: 1 },
      { id: 't2', subject: '融合成稿', status: 'in_progress', dependencies: ['t1'], assignee: '成员甲', attemptId: 'a1', attempt: 1, createdAt: 1, updatedAt: 1, planTask: { logicalId: 't2' } },
    ],
    taskSeq: 2,
    ...overrides,
  }
}

/** A task record the completing member owns (as update_task sees it). */
function fusionTask(overrides = {}) {
  return {
    id: 't2',
    subject: '融合成稿',
    status: 'in_progress',
    dependencies: ['t1'],
    assignee: '成员甲',
    attemptId: 'a1',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    planTask: { logicalId: 't2' },
    ...overrides,
  }
}

/** Synthetic stamped plan (not compiled) for soft/deliverable gate scenarios. */
function syntheticStamp(gates, overrides = {}) {
  return {
    planId: 'ep-test',
    policies: [{ id: 'test.quality', version: '1.0.0' }],
    gates,
    deliverables: [{ id: 'd1', fromTasks: ['t1', 't2'] }],
    maxRepairRounds: 2,
    ...overrides,
  }
}

// Zhijian framework-A output template declares five REQUIRED section markers
// (['一句话定性', '指标 2-3 项', '趋势预测', '不确定性', '关注指标']). The
// contract-driven schema-structure gate is injected at completion, so every
// zhijian test output must carry them (or the structure gate blocks first).
const ZHIJIAN_HEAD = ['一句话定性', '指标 2-3 项', '趋势预测', '不确定性', '关注指标'].map(section => `${section}：`).join('\n')
const COMPLIANCE_LEAK = `${ZHIJIAN_HEAD}\n顾云昌认为市场不会暴涨暴跌。`
const COMPLIANCE_FIXED = `${ZHIJIAN_HEAD}\n政策制度领域专家（首字母 G）认为市场不会暴涨暴跌。`
const UNCITED_NUMBER = `${ZHIJIAN_HEAD}\n上海二手房价环比上涨3.2%，成交量增加5%。`
const CITED_NUMBER = `${ZHIJIAN_HEAD}\n上海二手房价环比上涨3.2%（来源：贝壳，口径：成交价，2026-07）。`
/** Zhijian framework-A output that deliberately omits every required section. */
const NO_SECTIONS = '上海二手房市场筑底迹象明显，成交量回升。'

/* ---------------------------------------------------------------------------
 * Stamp
 * ------------------------------------------------------------------------- */

test('stampQualityPlan copies the compiled gate chain (zhijian binds t2)', () => {
  const plan = zhijianPlan()
  const stamp = stampQualityPlan(plan)
  assert.equal(stamp.planId, plan.planId)
  assert.deepEqual(stamp.policies, plan.bindings.qualityPolicies)
  // data-citation (phase data) before compliance-anonymization (phase compliance).
  assert.deepEqual(stamp.gates.map(gate => gate.gateId), ['data-citation', 'compliance-anonymization'])
  assert.deepEqual(stamp.gates.map(gate => gate.chainOrder), [0, 1])
  for (const gate of stamp.gates) {
    assert.equal(gate.severity, 'hard')
    assert.deepEqual(gate.appliesTo, ['t2'])
  }
  assert.deepEqual(stamp.deliverables, [{ id: 'd1', fromTasks: ['t2'] }])
  // Zhijian policy declares maxRepairRounds 2 — the design cap.
  assert.equal(stamp.maxRepairRounds, 2)
  // Output-schema contracts are stamped so completion can validate the output
  // against the declared template (framework A: five required section markers).
  assert.deepEqual(stamp.outputTemplates.map(template => template.id), ['zhijian.output.A'])
  assert.deepEqual(stamp.taskOutputSchemas, { t1: 'zhijian.output.A', t2: 'zhijian.output.A' })
  assert.ok(stamp.schemaStructure !== undefined, 'zhijian policy declares schema-structure')
  assert.equal(stamp.schemaStructure?.severity, 'hard')
  const contract = stamp.outputTemplates[0]
  assert.ok(contract?.sections.some(section => section.id === '一句话定性' && section.required === true))
})

test('zhijianComplianceTerms cover real names and the deceased expert bk-022', () => {
  const terms = zhijianComplianceTerms()
  assert.ok(terms.blockedTerms.includes('顾云昌'), 'real name of bk-022 must be blocked')
  assert.ok(terms.blockedTerms.includes('陶琦'), 'real name of bk-031 must be blocked')
  assert.ok(terms.deceasedTerms.includes('顾云昌'), 'deceased expert must be flagged')
  assert.ok(!terms.deceasedTerms.includes('陶琦'), 'live expert must not be flagged deceased')
})

/* ---------------------------------------------------------------------------
 * Hard-gate blocking + retry
 * ------------------------------------------------------------------------- */

test('completion blocked: real expert name in the output fails compliance-anonymization with correction guidance', () => {
  const team = teamFixture(zhijianPlan())
  const task = fusionTask()
  const outcome = evaluateTaskCompletionGates(team, task, COMPLIANCE_LEAK)
  assert.ok(outcome !== undefined, 'a gate must apply to the fusion task')
  assert.ok(outcome.blocked !== undefined, 'hard gate must block the completion')
  assert.equal(outcome.blocked.gateId, 'compliance-anonymization')
  assert.equal(outcome.blocked.taskId, 't2')
  assert.ok(outcome.blocked.reason.includes('blocked-identity'), `reason must cite the issue code: ${outcome.blocked.reason}`)
  assert.ok(outcome.blocked.reason.includes('顾云昌'), 'reason must cite the offending evidence')
  assert.ok(
    outcome.blocked.corrections.includes('实名字段仅内部视图；对外只列「领域·首字母」'),
    'corrections must carry the anonymization guidance',
  )
  assert.equal(outcome.budgetExhausted, false)
  assert.deepEqual(outcome.warnings, [])
})

test('deceased expert (bk-022) real name is blocked even in a current-sounding citation; historical form without the real name passes', () => {
  const team = teamFixture(zhijianPlan())
  // Real name without a historical marker: blocked (deceased-cited-as-current too).
  const blocked = evaluateTaskCompletionGates(team, fusionTask(), `${ZHIJIAN_HEAD}\n顾云昌 2026年指出市场见底。`)
  assert.ok(blocked?.blocked !== undefined)
  assert.equal(blocked?.blocked.gateId, 'compliance-anonymization')
  // A live expert's real name is blocked as well (领域·首字母 rule).
  const live = evaluateTaskCompletionGates(team, fusionTask(), `${ZHIJIAN_HEAD}\n陶琦认为挂牌量将上升。`)
  assert.ok(live?.blocked !== undefined)
  // Historical citation without the real name (领域·首字母 + 曾 marker) passes.
  const historical = evaluateTaskCompletionGates(team, fusionTask(), `${ZHIJIAN_HEAD}\n已故政策制度领域专家（首字母 G）曾指出：市场不会暴涨暴跌。`)
  assert.ok(historical !== undefined)
  assert.equal(historical.blocked, undefined)
  assert.deepEqual(historical.warnings, [])
})

test('retry succeeds after the member fixes the output', () => {
  const team = teamFixture(zhijianPlan())
  const task = fusionTask()
  const first = evaluateTaskCompletionGates(team, task, COMPLIANCE_LEAK)
  assert.ok(first?.blocked !== undefined, 'first attempt must be blocked')
  const second = evaluateTaskCompletionGates(team, task, COMPLIANCE_FIXED)
  assert.ok(second !== undefined)
  assert.equal(second.blocked, undefined, 'fixed output must clear the hard gate')
  assert.equal(second.budgetExhausted, false)
  assert.deepEqual(second.warnings, [])
})

test('data-citation blocks uncited numbers and passes once 来源/口径 is present', () => {
  const team = teamFixture(zhijianPlan())
  const task = fusionTask()
  const blocked = evaluateTaskCompletionGates(team, task, UNCITED_NUMBER)
  assert.ok(blocked?.blocked !== undefined)
  assert.equal(blocked.blocked.gateId, 'data-citation')
  assert.ok(blocked.blocked.reason.includes('number-without-source'))
  assert.ok(
    blocked.blocked.corrections.includes('为数字补来源/时段/区域/单位/口径（或明确标注为估算值）'),
    'corrections must tell the member how to fix it',
  )
  const passed = evaluateTaskCompletionGates(team, task, CITED_NUMBER)
  assert.equal(passed?.blocked, undefined)
  assert.deepEqual(passed?.warnings, [])
})

test('gate failure message includes the gate id and the correction text', () => {
  const team = teamFixture(zhijianPlan())
  const blocked = evaluateTaskCompletionGates(team, fusionTask(), COMPLIANCE_LEAK)
  const message = taskGateBlockedError(blocked.blocked).message
  assert.ok(message.includes('compliance-anonymization'), `message must name the gate: ${message}`)
  assert.ok(message.includes('correction: 实名字段仅内部视图；对外只列「领域·首字母」'), 'message must carry the correction verbatim')
  assert.ok(message.includes('task t2 completion blocked'), 'message must identify the task')
  assert.ok(message.includes('attempt 1/2'), 'message must state where the budget stands')
})

/* ---------------------------------------------------------------------------
 * Soft gates
 * ------------------------------------------------------------------------- */

test('soft-gate warnings attach to the result (and would land on TeamTask.gateWarnings)', () => {
  const stamp = syntheticStamp([
    {
      id: 'test.quality/style-lint',
      policyId: 'test.quality',
      gateId: 'style-lint',
      kind: 'deterministic',
      phase: 'style',
      severity: 'soft',
      appliesTo: ['t2'],
      chainOrder: 0,
    },
  ])
  const team = teamFixture(zhijianPlan(), { qualityPlan: stamp })
  const task = fusionTask()
  const phrasey = '## 结论\n综上所述，市场正在回暖。总而言之，政策在发力。综上所述，成交量回升。总而言之，价格企稳。综上所述，库存下降。总而言之，预期改善。'
  const outcome = evaluateTaskCompletionGates(team, task, phrasey)
  assert.ok(outcome !== undefined)
  assert.equal(outcome.blocked, undefined, 'soft gates never block')
  assert.equal(outcome.budgetExhausted, false)
  assert.ok(outcome.warnings.length > 0, 'soft-gate issues must surface as warnings')
  const joined = outcome.warnings.join('\n')
  assert.ok(joined.includes('style-lint'), `warning must name the gate: ${joined}`)
  assert.ok(joined.includes('phrase-density'), `warning must carry the issue code: ${joined}`)
  assert.ok(joined.includes('削减套话'), 'warning must carry the correction')
})

/* ---------------------------------------------------------------------------
 * Aggregate score + subject marker
 * ------------------------------------------------------------------------- */

test('deriveQualityScore: hard all pass = 80 + soft pass ratio ×20; hard fail = low band 0–59', () => {
  const team = teamFixture(zhijianPlan())
  // Clean zhijian pass (data-citation + compliance-anonymization, both hard,
  // no soft gates): hard all pass, no soft ⇒ soft ratio 1 ⇒ 100.
  const clean = evaluateTaskCompletionGates(team, fusionTask(), COMPLIANCE_FIXED)
  assert.equal(clean?.score, 100)
  // Compliance fails (hard), schema + data pass (injected schema-structure
  // gate is part of the chain): hard fail ⇒ 59 × (2 passed / 3 gates).
  const blocked = evaluateTaskCompletionGates(team, fusionTask(), COMPLIANCE_LEAK)
  assert.equal(blocked?.blocked?.score, 39)
  assert.equal(blocked?.score, 39)
  // Data + compliance both fail (schema passes): 59 × (1 / 3) = 20.
  const doubleHard = evaluateTaskCompletionGates(team, fusionTask(), `${ZHIJIAN_HEAD}\n顾云昌 2026年指出市场环比上涨3.2%。`)
  assert.equal(doubleHard?.blocked?.score, 20)
  // Soft gate warns (style-lint phrase-density): hard all pass, soft ratio 0/1
  // ⇒ 80 + 20×0 = 80.
  const stamp = syntheticStamp([
    {
      id: 'test.quality/style-lint',
      policyId: 'test.quality',
      gateId: 'style-lint',
      kind: 'deterministic',
      phase: 'style',
      severity: 'soft',
      appliesTo: ['t2'],
      chainOrder: 0,
    },
  ])
  const softTeam = teamFixture(zhijianPlan(), { qualityPlan: stamp })
  const phrasey = '## 结论\n综上所述，市场正在回暖。总而言之，政策在发力。综上所述，成交量回升。总而言之，价格企稳。综上所述，库存下降。总而言之，预期改善。'
  assert.equal(evaluateTaskCompletionGates(softTeam, fusionTask(), phrasey)?.score, 80)
  // Soft gate fails (word-limit-exceeded): soft ratio 0 ⇒ 80.
  const long = '## 结论\n' + '很长的内容。'.repeat(800)
  assert.equal(evaluateTaskCompletionGates(softTeam, fusionTask(), long)?.score, 80)
  // Soft gates weighted by pass ratio: one soft pass + one soft warn ⇒
  // 80 + 20 × (1/2) = 90.
  const mixedStamp = syntheticStamp([
    {
      id: 'test.quality/style-lint',
      policyId: 'test.quality',
      gateId: 'style-lint',
      kind: 'deterministic',
      phase: 'style',
      severity: 'soft',
      appliesTo: ['t2'],
      chainOrder: 0,
    },
    {
      id: 'test.quality/data-citation',
      policyId: 'test.quality',
      gateId: 'data-citation',
      kind: 'deterministic',
      phase: 'data',
      severity: 'soft',
      appliesTo: ['t2'],
      chainOrder: 1,
    },
  ])
  const mixedTeam = teamFixture(zhijianPlan(), { qualityPlan: mixedStamp })
  const oneWarn = evaluateTaskCompletionGates(mixedTeam, fusionTask(), phrasey)
  assert.equal(oneWarn?.score, 90)
  const allPass = evaluateTaskCompletionGates(mixedTeam, fusionTask(), COMPLIANCE_FIXED)
  assert.equal(allPass?.score, 100)
})

test('deriveQualityScore rule constants are the documented bands', () => {
  assert.equal(QUALITY_BASE_SCORE, 80)
  assert.equal(QUALITY_SOFT_WEIGHT, 20)
  assert.equal(QUALITY_HARD_FAIL_MAX, 59)
})

/* ---------------------------------------------------------------------------
 * Output-schema validation (schema-structure vs the plan's outputTemplate)
 * ------------------------------------------------------------------------- */

test('output violating the declared output schema fails the injected schema-structure gate with correction', () => {
  const team = teamFixture(zhijianPlan())
  // NO_SECTIONS omits every required section marker of zhijian.output.A.
  const outcome = evaluateTaskCompletionGates(team, fusionTask(), NO_SECTIONS)
  assert.ok(outcome?.blocked !== undefined, 'missing required sections must block completion')
  assert.equal(outcome.blocked.gateId, 'schema-structure')
  assert.ok(outcome.blocked.reason.includes('missing-section'), `reason must cite the issue code: ${outcome.blocked.reason}`)
  assert.ok(
    outcome.blocked.corrections.includes('补充必填章节 "一句话定性"'),
    'corrections must name the missing required section',
  )
  // The empty artifact is caught by the structure gate too.
  const empty = evaluateTaskCompletionGates(team, fusionTask(), '')
  assert.equal(empty?.blocked?.gateId, 'schema-structure')
  assert.ok(empty?.blocked?.reason.includes('empty-artifact'))
})

test('output satisfying every required section passes the schema-structure gate', () => {
  const team = teamFixture(zhijianPlan())
  const outcome = evaluateTaskCompletionGates(team, fusionTask(), COMPLIANCE_FIXED)
  assert.ok(outcome !== undefined)
  assert.equal(outcome.blocked, undefined)
  assert.equal(outcome.score, 100)
})

test('JSON output-template contract: invalid JSON fails with correction, valid JSON passes', () => {
  const stamp = syntheticStamp([], {
    outputTemplates: [{ id: 'test.json', media: ['json'], sections: [] }],
    taskOutputSchemas: { t2: 'test.json' },
    schemaStructure: { policyId: 'test.quality', severity: 'hard' },
  })
  const team = teamFixture(zhijianPlan(), { qualityPlan: stamp })
  const bad = evaluateTaskCompletionGates(team, fusionTask(), '{ 不是 JSON }')
  assert.ok(bad?.blocked !== undefined)
  assert.equal(bad.blocked.gateId, 'schema-structure')
  assert.ok(bad.blocked.reason.includes('invalid-json'), `reason must cite invalid-json: ${bad.blocked.reason}`)
  assert.ok(bad.blocked.corrections.some(line => line.includes('JSON')), 'correction must guide JSON repair')
  const good = evaluateTaskCompletionGates(team, fusionTask(), JSON.stringify({ conclusion: '市场筑底', trend: '企稳' }))
  assert.equal(good?.blocked, undefined)
})

test('ad-hoc / legacy teams get no schema-structure injection (no policy declares the gate)', () => {
  // Ad-hoc: no qualityPlan at all → undefined (today's behavior).
  const adhoc = {
    id: 'team-adhoc', name: '自由团队', captainSessionId: 'sess-captain', createdAt: 1,
    members: [], tasks: [fusionTask()], taskSeq: 1,
  }
  assert.equal(evaluateTaskCompletionGates(adhoc, fusionTask(), NO_SECTIONS), undefined)
  // Legacy scenario team: legacy quality policy has no gates → undefined.
  const legacy = {
    id: 'team-legacy', name: '旧场景团队', captainSessionId: 'sess-captain', createdAt: 1,
    scenarioId: 'market-research',
    planRef: { planId: 'ep-legacy', digest: 'x', templateId: 'market-research.legacy-team', templateVersion: '0.0.0-legacy' },
    members: [], tasks: [fusionTask()], taskSeq: 1,
  }
  assert.equal(evaluateTaskCompletionGates(legacy, fusionTask(), NO_SECTIONS), undefined)
  // A stamped plan whose policy declares no schema-structure gate: no injection.
  const noSchema = teamFixture(zhijianPlan(), { qualityPlan: syntheticStamp([]) })
  assert.equal(evaluateTaskCompletionGates(noSchema, fusionTask(), NO_SECTIONS), undefined)
})

test('subjectWithQualityMark is idempotent — replaces the old marker, never stacks', () => {
  const first = subjectWithQualityMark('融合成文', 92, false)
  assert.equal(first, '融合成文 〔质 92〕')
  // Re-evaluation replaces the marker in place (no stacking).
  const second = subjectWithQualityMark(first, 95, false)
  assert.equal(second, '融合成文 〔质 95〕')
  // Hard-gate block marker.
  const blocked = subjectWithQualityMark(first, 58, true)
  assert.equal(blocked, '融合成文 〔质 58·硬门未过〕')
  // A later pass replaces the blocked marker too.
  const recovered = subjectWithQualityMark(blocked, 96, false)
  assert.equal(recovered, '融合成文 〔质 96〕')
  // No trailing space residue from the removed marker.
  assert.equal(subjectWithQualityMark('融合成文 〔质 92〕', 93, false), '融合成文 〔质 93〕')
})

/* ---------------------------------------------------------------------------
 * Forced recovery: qualityScore + repairCount always present
 * ------------------------------------------------------------------------- */

/** A task project so `commitTaskUpdate` writes the durable result.json. */
const PROJECT = {
  path: 'expert-tasks/t2',
  inputPath: 'expert-tasks/t2/input/task.json',
  outputPath: 'expert-tasks/t2/output/result.json',
  artifactsPath: 'expert-tasks/t2/artifacts',
  version: 1,
}

async function writeProjectDirs(root) {
  await mkdir(join(root, 'team-tool', 'expert-tasks', 't2', 'output'), { recursive: true })
}

test('tool: quality_score/repair_count forced into the result even when the member output never mentions them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    const team = toolTeamFixture(zhijianPlan())
    team.tasks[0].project = PROJECT
    const stateRoot = join(workspace, '.expert-teams')
    await writeTeamFixture(stateRoot, team)
    await writeProjectDirs(stateRoot)
    const exec = { agent: member, session: member.session, signal: new AbortController().signal }

    const result = await tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_FIXED, attempt_id: 'a1' }, exec)
    // The member's output contains no score — the system forces the fields in.
    assert.equal(result.quality_score, 100)
    assert.equal(result.repair_count, 0)
    assert.equal(result.gate_warnings, undefined)
    const record = JSON.parse(await readFile(join(stateRoot, 'team-tool', PROJECT.outputPath), 'utf8'))
    assert.equal(record.qualityScore, 100)
    assert.equal(record.repairCount, 0)
    const loaded = await readTeam(stateRoot, 'team-tool')
    assert.equal(loaded?.tasks[0]?.qualityScore, 100)
    assert.equal(loaded?.tasks[0]?.repairCount, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool: repair_count increments across blocked retries and stays accurate after the fixed pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    const team = toolTeamFixture(zhijianPlan())
    team.tasks[0].project = PROJECT
    const stateRoot = join(workspace, '.expert-teams')
    await writeTeamFixture(stateRoot, team)
    await writeProjectDirs(stateRoot)
    const exec = { agent: member, session: member.session, signal: new AbortController().signal }
    const complete = (output) => tool.execute({ task_id: 't2', status: 'completed', output, attempt_id: 'a1' }, exec)

    // 1st blocked attempt → repairCount 1, score 39 (59 × 2/3), marker 硬门未过.
    await assert.rejects(complete(COMPLIANCE_LEAK), /compliance-anonymization/)
    let loaded = await readTeam(stateRoot, 'team-tool')
    assert.equal(loaded?.tasks[0]?.repairCount, 1)
    assert.equal(loaded?.tasks[0]?.qualityScore, 39)

    // 2nd blocked attempt → repairCount 2 (budget not yet spent).
    await assert.rejects(complete(COMPLIANCE_LEAK), /compliance-anonymization/)
    loaded = await readTeam(stateRoot, 'team-tool')
    assert.equal(loaded?.tasks[0]?.repairCount, 2)
    assert.equal(loaded?.tasks[0]?.qualityScore, 39)

    // Fixed pass: repair rounds used stay 2, score 100 — record reflects both.
    const fixed = await complete(COMPLIANCE_FIXED)
    assert.equal(fixed.status, 'completed')
    assert.equal(fixed.quality_score, 100)
    assert.equal(fixed.repair_count, 2)
    const record = JSON.parse(await readFile(join(stateRoot, 'team-tool', PROJECT.outputPath), 'utf8'))
    assert.equal(record.qualityScore, 100)
    assert.equal(record.repairCount, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool: no-policy team still records qualityScore: null / repairCount: 0 — fields always present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    const team = toolTeamFixture(zhijianPlan(), {
      id: 'team-adhoc',
      name: '自由团队',
      tasks: [
        { id: 't2', subject: '随便写', status: 'in_progress', dependencies: [], assignee: '成员甲', attemptId: 'a1', attempt: 1, createdAt: 1, updatedAt: 1, project: PROJECT },
      ],
    })
    delete team.qualityPlan
    delete team.planRef
    delete team.scenarioId
    const stateRoot = join(workspace, '.expert-teams')
    await writeTeamFixture(stateRoot, team)
    await mkdir(join(stateRoot, 'team-adhoc', 'expert-tasks', 't2', 'output'), { recursive: true })
    const exec = { agent: member, session: member.session, signal: new AbortController().signal }

    const result = await tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_LEAK, attempt_id: 'a1' }, exec)
    assert.equal(result.status, 'completed')
    assert.equal(result.quality_score, null, 'no policy ⇒ quality_score null but the field exists')
    assert.equal(result.repair_count, 0)
    const record = JSON.parse(await readFile(join(stateRoot, 'team-adhoc', PROJECT.outputPath), 'utf8'))
    assert.equal('qualityScore' in record, true, 'result.json must always carry qualityScore')
    assert.equal(record.qualityScore, null)
    assert.equal('repairCount' in record, true, 'result.json must always carry repairCount')
    assert.equal(record.repairCount, 0)
    const loaded = await readTeam(stateRoot, 'team-adhoc')
    assert.equal(loaded?.tasks[0]?.qualityScore, null)
    assert.equal(loaded?.tasks[0]?.repairCount, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool: human-readable text output shows 质量分 X ｜ 修复 N 轮 (no-policy → 质量分 — ｜ 修复 0 轮)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    const exec = { agent: member, session: member.session, signal: new AbortController().signal }
    const renderOf = (result) => tool.output.render({}, result)[0].text

    // Gated team: clean pass → 质量分 100 ｜ 修复 0 轮.
    await writeTeamFixture(join(workspace, '.expert-teams'), toolTeamFixture(zhijianPlan()))
    const gated = await tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_FIXED, attempt_id: 'a1' }, exec)
    const gatedText = renderOf(gated)
    assert.match(gatedText, /质量分/, 'text output must carry 质量分')
    assert.match(gatedText, /修复/, 'text output must carry 修复')
    assert.match(gatedText, /质量分 100 ｜ 修复 0 轮/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  // No-policy team (separate workspace to avoid multi-team ambiguity).
  const dir2 = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir2
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    const adhoc = toolTeamFixture(zhijianPlan(), {
      id: 'team-adhoc',
      name: '自由团队',
      tasks: [
        { id: 't2', subject: '随便写', status: 'in_progress', dependencies: [], assignee: '成员甲', attemptId: 'a1', attempt: 1, createdAt: 1, updatedAt: 1 },
      ],
    })
    delete adhoc.qualityPlan
    delete adhoc.planRef
    delete adhoc.scenarioId
    await writeTeamFixture(join(workspace, '.expert-teams'), adhoc)
    const none = await tool.execute(
      { task_id: 't2', status: 'completed', output: COMPLIANCE_LEAK, attempt_id: 'a1' },
      { agent: member, session: member.session, signal: new AbortController().signal },
    )
    assert.equal(none.quality_score, null)
    const noneText = tool.output.render({}, none)[0].text
    assert.match(noneText, /质量分 — ｜ 修复 0 轮/, 'no-policy text output must read 质量分 — ｜ 修复 0 轮')
  } finally {
    await rm(dir2, { recursive: true, force: true })
  }
})

test('score enters the evaluation result and the durable subject through the tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    await writeTeamFixture(join(workspace, '.expert-teams'), toolTeamFixture(zhijianPlan()))
    const exec = { agent: member, session: member.session, signal: new AbortController().signal }

    // Hard-gate block: marker carries 硬门未过 and the derived score.
    await assert.rejects(
      tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_LEAK, attempt_id: 'a1' }, exec),
      /compliance-anonymization/,
    )
    let team = await readTeam(join(workspace, '.expert-teams'), 'team-tool')
    assert.equal(team?.tasks[0]?.subject, '融合成稿 〔质 39·硬门未过〕')

    // Fixed retry: marker replaced (single, no stacking), score 100.
    const fixed = await tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_FIXED, attempt_id: 'a1' }, exec)
    assert.equal(fixed.status, 'completed')
    team = await readTeam(join(workspace, '.expert-teams'), 'team-tool')
    assert.equal(team?.tasks[0]?.subject, '融合成稿 〔质 100〕')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * No-policy teams behave exactly as before
 * ------------------------------------------------------------------------- */

test('ad-hoc team (no plan, no scenario) is unaffected — evaluation returns undefined', () => {
  const team = {
    id: 'team-adhoc',
    name: '自由团队',
    captainSessionId: 'sess-captain',
    createdAt: 1,
    members: [],
    tasks: [fusionTask()],
    taskSeq: 1,
  }
  const outcome = evaluateTaskCompletionGates(team, fusionTask(), COMPLIANCE_LEAK)
  assert.equal(outcome, undefined, 'no resolvable policy ⇒ today\'s behavior (no gates)')
})

test('legacy scenario team (empty legacy quality policy) is unaffected', () => {
  const team = {
    id: 'team-legacy',
    name: '旧场景团队',
    captainSessionId: 'sess-captain',
    createdAt: 1,
    scenarioId: 'market-research',
    planRef: {
      planId: 'ep-legacy',
      digest: 'x',
      templateId: 'market-research.legacy-team',
      templateVersion: '0.0.0-legacy',
    },
    members: [],
    tasks: [fusionTask()],
    taskSeq: 1,
  }
  const outcome = evaluateTaskCompletionGates(team, fusionTask(), COMPLIANCE_LEAK)
  assert.equal(outcome, undefined, 'legacy policy has no executable gates ⇒ no-op')
})

/* ---------------------------------------------------------------------------
 * Repair-round budget (≤2 rounds, third completion may proceed with warning)
 * ------------------------------------------------------------------------- */

test('repair budget honored: two blocks, then the third completion proceeds with a recorded warning', () => {
  const team = teamFixture(zhijianPlan())
  // Attempt 1: no prior failures → blocked, budgetUsed 1.
  const first = evaluateTaskCompletionGates(team, fusionTask({ gateFailCount: 0 }), COMPLIANCE_LEAK)
  assert.ok(first?.blocked !== undefined)
  assert.equal(first.blocked.budgetUsed, 1)
  assert.equal(first.blocked.budgetTotal, 2)
  // Attempt 2: one prior block → blocked again, budgetUsed 2.
  const second = evaluateTaskCompletionGates(team, fusionTask({ gateFailCount: 1 }), COMPLIANCE_LEAK)
  assert.ok(second?.blocked !== undefined)
  assert.equal(second.blocked.budgetUsed, 2)
  // Attempt 3: two prior blocks (budget spent) → completion proceeds with a warning.
  const third = evaluateTaskCompletionGates(team, fusionTask({ gateFailCount: 2 }), COMPLIANCE_LEAK)
  assert.ok(third !== undefined)
  assert.equal(third.blocked, undefined, 'third attempt must not block once the budget is spent')
  assert.equal(third.budgetExhausted, true)
  assert.ok(third.warnings.length > 0, 'the waived hard failure must be recorded as a warning')
  const joined = third.warnings.join('\n')
  assert.ok(joined.includes('compliance-anonymization'), `warning must name the failing gate: ${joined}`)
  assert.ok(joined.includes('repair budget exhausted'), 'warning must explain the waiver')
  assert.ok(joined.includes('顾云昌'), 'warning must keep the underlying evidence')
})

test('policy granting no repair rounds blocks forever (budget 0)', () => {
  const stamp = syntheticStamp([
    {
      id: 'test.quality/compliance-anonymization',
      policyId: 'test.quality',
      gateId: 'compliance-anonymization',
      kind: 'deterministic',
      phase: 'compliance',
      severity: 'hard',
      appliesTo: ['t2'],
      chainOrder: 0,
    },
  ], { maxRepairRounds: 0 })
  const team = teamFixture(zhijianPlan(), { qualityPlan: stamp })
  for (const gateFailCount of [0, 1, 5]) {
    const outcome = evaluateTaskCompletionGates(team, fusionTask({ gateFailCount }), COMPLIANCE_LEAK)
    assert.ok(outcome?.blocked !== undefined, `no relief with budget 0 (failCount ${gateFailCount})`)
    assert.equal(outcome.blocked.budgetTotal, 0)
  }
  const message = taskGateBlockedError(evaluateTaskCompletionGates(team, fusionTask({ gateFailCount: 5 }), COMPLIANCE_LEAK).blocked).message
  assert.ok(message.includes('grants no repair rounds'), 'message must explain the zero-budget contract')
})

/* ---------------------------------------------------------------------------
 * Deliverable-targeted gates
 * ------------------------------------------------------------------------- */

test('deliverable-targeted gate composes every source task output once all sources are complete', () => {
  const stamp = syntheticStamp([
    {
      id: 'test.quality/schema-structure',
      policyId: 'test.quality',
      gateId: 'schema-structure',
      kind: 'deterministic',
      phase: 'structure',
      severity: 'hard',
      appliesTo: ['deliverable'],
      chainOrder: 0,
      config: { requiredSections: ['# 结论'] },
    },
  ])
  const team = teamFixture(zhijianPlan(), {
    qualityPlan: stamp,
    tasks: [
      { id: 't1', subject: '专家研判', status: 'completed', dependencies: [], output: '# 结论\n上海二手房市场筑底迹象明显。', createdAt: 1, updatedAt: 1 },
      { id: 't2', subject: '融合成稿', status: 'in_progress', dependencies: ['t1'], assignee: '成员甲', attemptId: 'a1', attempt: 1, createdAt: 1, updatedAt: 1, planTask: { logicalId: 't2' } },
    ],
  })
  // t1 (completed) carries the required section; t2's own output does not —
  // the composed deliverable still passes because t1 contributes it.
  const outcome = evaluateTaskCompletionGates(team, fusionTask(), '融合稿正文，无章节标题。')
  assert.ok(outcome !== undefined, 'gate applies once all deliverable sources are complete')
  assert.equal(outcome.blocked, undefined, 'composed artifact must contain t1\'s section')
  // When an upstream source is not complete the deliverable cannot be composed:
  // no gate applies, exactly like today.
  const incomplete = teamFixture(zhijianPlan(), {
    qualityPlan: stamp,
    tasks: [
      { id: 't1', subject: '专家研判', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 },
      { id: 't2', subject: '融合成稿', status: 'in_progress', dependencies: ['t1'], createdAt: 1, updatedAt: 1, planTask: { logicalId: 't2' } },
    ],
  })
  const none = evaluateTaskCompletionGates(incomplete, fusionTask(), '融合稿正文。')
  assert.equal(none, undefined, 'no complete deliverable ⇒ no gates run')
})

/* ---------------------------------------------------------------------------
 * End-to-end through the registered tool (temp-dir team records)
 * ------------------------------------------------------------------------- */

/**
 * Register the real `expert_teams_*` tool family with a minimal mock ctx that
 * satisfies registration (retired-member guard / member selection / scheduler
 * installers) and the update_task execute path (agents lookup, logger). The
 * scheduler's member dispatch is inert: members report busy, and a completed
 * single-task team hits the all-terminal short circuit, so no subagent is
 * ever spawned or woken.
 */
function registerAndGetUpdateTaskTool() {
  const tools = new Map()
  const agentById = new Map()
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool) } },
    logger: { debug() {}, warn() {}, info() {} },
    subagents: {
      registerContinuableSetup() {},
      list: () => [],
      listChildren: async () => [],
      listDescendants: async () => [],
      followup: async () => { throw new Error('unexpected followup in gate tests') },
      getProvider: () => undefined,
      startContinuable: async () => { throw new Error('unexpected spawn in gate tests') },
      interrupt: async () => {},
    },
    effect() {},
    on() {},
    agents: { get: (id) => agentById.get(id) },
  }
  registerExpertTeamsTools(ctx, {
    stateDir: '.expert-teams',
    memberProvider: 'spawn',
    maxMembers: 8,
    knowledgeDir: 'knowledge',
    packsDir: 'domain-packs',
  })
  const tool = tools.get('expert_teams_update_task')
  assert.ok(tool, 'expert_teams_update_task must be registered')
  return { tool, agentById }
}

function agentFixture(workspace, id) {
  return {
    id,
    session: {
      header: { cwd: workspace, seedLength: 0 },
      events: [],
      append() {},
      steer() {},
    },
  }
}

/** Durable single-task team (t2 fusion, member-owned) for the tool tests. */
function toolTeamFixture(plan, overrides = {}) {
  return {
    id: 'team-tool',
    name: '门控工具团队',
    captainSessionId: 'sess-captain',
    createdAt: 1,
    scenarioId: plan.scenario?.id,
    planRef: {
      planId: plan.planId,
      digest: plan.digest,
      templateId: plan.template.id,
      templateVersion: plan.template.version,
    },
    qualityPlan: stampQualityPlan(plan),
    members: [{ id: 'sess-member', name: '成员甲', joinedAt: 1, status: 'idle' }],
    tasks: [
      { id: 't2', subject: '融合成稿', status: 'in_progress', dependencies: [], assignee: '成员甲', attemptId: 'a1', attempt: 1, createdAt: 1, updatedAt: 1, planTask: { logicalId: 't2' } },
    ],
    taskSeq: 1,
    ...overrides,
  }
}

async function writeTeamFixture(root, team) {
  await mkdir(join(root, team.id), { recursive: true })
  await writeFile(join(root, team.id, 'team.json'), JSON.stringify(team))
}

test('tool: completion blocked by a failing hard gate — task stays in_progress, only the budget counter persists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    await writeTeamFixture(join(workspace, '.expert-teams'), toolTeamFixture(zhijianPlan()))
    const exec = { agent: member, session: member.session, signal: new AbortController().signal }
    await assert.rejects(
      tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_LEAK, attempt_id: 'a1' }, exec),
      (error) => {
        assert.match(error.message, /compliance-anonymization/, 'error must name the gate')
        assert.match(error.message, /correction: 实名字段仅内部视图；对外只列「领域·首字母」/, 'error must carry the correction')
        assert.match(error.message, /attempt 1\/2/, 'error must state where the budget stands')
        return true
      },
    )
    const team = await readTeam(join(workspace, '.expert-teams'), 'team-tool')
    const task = team?.tasks[0]
    assert.equal(task?.status, 'in_progress', 'blocked completion must not move the task to terminal')
    assert.equal(task?.gateFailCount, 1, 'the repair-budget counter must persist')
    assert.equal(task?.attemptId, 'a1', 'the live capability must survive a block')
    assert.equal(task?.output, undefined, 'the failing output must not be persisted')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool: retry after fixing the output succeeds — budget counter kept, task completes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    await writeTeamFixture(join(workspace, '.expert-teams'), toolTeamFixture(zhijianPlan()))
    const stateRoot = join(workspace, '.expert-teams')
    const exec = { agent: member, session: member.session, signal: new AbortController().signal }

    await assert.rejects(
      tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_LEAK, attempt_id: 'a1' }, exec),
      /compliance-anonymization/,
    )

    const second = await tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_FIXED, attempt_id: 'a1' }, exec)
    assert.equal(second.status, 'completed')
    assert.equal(second.output, COMPLIANCE_FIXED)
    assert.equal(second.gate_warnings, undefined, 'clean pass carries no warnings')

    const team = await readTeam(stateRoot, 'team-tool')
    const task = team?.tasks[0]
    assert.equal(task?.status, 'completed')
    assert.equal(task?.gateFailCount, 1, 'budget counter is kept for audit after the block')
    assert.equal(task?.output, COMPLIANCE_FIXED)
    assert.equal(task?.attemptId, undefined, 'terminal work drops its capability')

    // Idempotent re-read of a terminal task includes the durable record.
    const again = await tool.execute({ task_id: 't2', status: 'completed', output: COMPLIANCE_FIXED, attempt_id: 'a1' }, exec)
    assert.equal(again.status, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool: soft-gate warnings attach to the result and the durable task record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    const stamp = syntheticStamp([
      {
        id: 'test.quality/style-lint',
        policyId: 'test.quality',
        gateId: 'style-lint',
        kind: 'deterministic',
        phase: 'style',
        severity: 'soft',
        appliesTo: ['t2'],
        chainOrder: 0,
      },
    ])
    await writeTeamFixture(join(workspace, '.expert-teams'), toolTeamFixture(zhijianPlan(), { qualityPlan: stamp }))
    const phrasey = '## 结论\n综上所述，市场正在回暖。总而言之，政策在发力。综上所述，成交量回升。总而言之，价格企稳。综上所述，库存下降。总而言之，预期改善。'
    const result = await tool.execute(
      { task_id: 't2', status: 'completed', output: phrasey, attempt_id: 'a1' },
      { agent: member, session: member.session, signal: new AbortController().signal },
    )
    assert.equal(result.status, 'completed')
    assert.ok(Array.isArray(result.gate_warnings) && result.gate_warnings.length > 0, 'soft warnings must be returned')
    assert.ok(result.gate_warnings.some(line => line.includes('style-lint')), 'warnings must name the gate')
    const team = await readTeam(join(workspace, '.expert-teams'), 'team-tool')
    assert.ok(team?.tasks[0]?.gateWarnings?.some(line => line.includes('style-lint')), 'warnings must persist on the task')
    // Soft penalties lower the score and are visible in the subject marker.
    assert.equal(team?.tasks[0]?.subject, '融合成稿 〔质 80〕')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tool: ad-hoc team (no plan, no scenario) completes exactly as before — no gates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-tool-'))
  try {
    const workspace = dir
    const { tool, agentById } = registerAndGetUpdateTaskTool()
    const captain = agentFixture(workspace, 'sess-captain')
    const member = agentFixture(workspace, 'sess-member')
    agentById.set('sess-captain', captain)
    agentById.set('sess-member', member)
    const team = toolTeamFixture(zhijianPlan(), {
      id: 'team-adhoc',
      name: '自由团队',
      tasks: [
        { id: 't2', subject: '随便写', status: 'in_progress', dependencies: [], assignee: '成员甲', attemptId: 'a1', attempt: 1, createdAt: 1, updatedAt: 1 },
      ],
    })
    delete team.qualityPlan
    delete team.planRef
    delete team.scenarioId
    await writeTeamFixture(join(workspace, '.expert-teams'), team)
    const result = await tool.execute(
      { task_id: 't2', status: 'completed', output: COMPLIANCE_LEAK, attempt_id: 'a1' },
      { agent: member, session: member.session, signal: new AbortController().signal },
    )
    assert.equal(result.status, 'completed')
    assert.equal(result.gate_warnings, undefined, 'no policy ⇒ today\'s behavior')
    const loaded = await readTeam(join(workspace, '.expert-teams'), 'team-adhoc')
    assert.equal(loaded?.tasks[0]?.status, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * Durable record round-trip
 * ------------------------------------------------------------------------- */

test('stamped quality plan round-trips through the durable team record and still gates completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expert-teams-quality-'))
  try {
    const plan = zhijianPlan()
    const team = teamFixture(plan)
    const root = join(dir, 'state')
    await mkdir(join(root, team.id), { recursive: true })
    await writeFile(join(root, team.id, 'team.json'), JSON.stringify(team))
    const loaded = await readTeam(root, team.id)
    assert.ok(loaded !== undefined)
    assert.deepEqual(loaded.qualityPlan?.policies, plan.bindings.qualityPolicies)
    assert.deepEqual(loaded.qualityPlan?.gates.map(gate => gate.gateId), ['data-citation', 'compliance-anonymization'])
    assert.equal(loaded.qualityPlan?.maxRepairRounds, 2)
    const outcome = evaluateTaskCompletionGates(loaded, loaded.tasks[1], COMPLIANCE_LEAK)
    assert.ok(outcome?.blocked !== undefined, 'the persisted stamp must still block')
    assert.equal(outcome.blocked.gateId, 'compliance-anonymization')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
