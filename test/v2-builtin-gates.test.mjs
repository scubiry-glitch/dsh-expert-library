/**
 * Phase 4 builtin deterministic gate evaluator tests: structure, data-citation
 * (null≠0 guard), compliance (blocked/internal-only/deceased), style
 * (phrase-density/word-limit), Zhijian-policy execution, and the explicit
 * rule that semantic/visual gates are never faked.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createBuiltinGateEvaluators,
  BUILTIN_DETERMINISTIC_GATE_IDS,
  runQualityChain,
  buildZhijianDomainPack,
} from '../lib/v2/index.js'

const now = () => () => '2026-08-01T00:00:00.000Z'

/** One compiled deterministic gate over artifact `d1`. */
function gate(gateId, { severity = 'hard', config, appliesTo = ['d1'] } = {}) {
  return {
    id: `policy/${gateId}`,
    kind: 'deterministic',
    phase: 'structure',
    chainOrder: 0,
    policyId: 'policy',
    policyVersion: '1.0.0',
    gateId,
    severity,
    appliesTo,
    ...(config === undefined ? {} : { config }),
  }
}

function run(gates, evaluators, content, extra = {}) {
  return runQualityChain({
    gates,
    evaluators,
    artifacts: { d1: { content } },
    now: now(),
    ...extra,
  })
}

test('structure: empty artifact and missing required sections fail', () => {
  const empty = run([gate('schema-structure')], createBuiltinGateEvaluators(), '   ')
  assert.equal(empty.outcome, 'failed')
  assert.equal(empty.deliverableAllowed, false)
  const emptyIssue = empty.rounds[0].results[0].issues[0]
  assert.equal(emptyIssue.code, 'empty-artifact')
  assert.ok(emptyIssue.correction)

  const missing = run(
    [gate('schema-structure', { config: { sections: ['## 结论', '## 数据'] } })],
    createBuiltinGateEvaluators(),
    '## 结论\n上海回暖。',
  )
  assert.equal(missing.outcome, 'failed')
  const issue = missing.rounds[0].results[0].issues.find(i => i.code === 'missing-section')
  assert.ok(issue !== undefined)
  assert.equal(issue.location, '## 数据')
  assert.ok(issue.evidence.includes('## 数据'))
  assert.ok(issue.correction)

  const ok = run(
    [gate('schema-structure', { config: { sections: ['## 结论', '## 数据'] } })],
    createBuiltinGateEvaluators(),
    '## 结论\n回暖。\n## 数据\n3.2%（来源：克而瑞）。',
  )
  assert.equal(ok.outcome, 'pass')
})

test('data-citation: numbers need provenance and null must never become 0', () => {
  const runData = (content, config) => run([gate('data-citation', { config })], createBuiltinGateEvaluators(), content)

  const uncited = runData('上海成交均价上涨 3.2%。')
  assert.equal(uncited.outcome, 'failed')
  const noSource = uncited.rounds[0].results[0].issues.find(i => i.code === 'number-without-source')
  assert.ok(noSource !== undefined)
  assert.equal(noSource.location, 'line 1')
  assert.ok(noSource.evidence.includes('3.2%'))
  assert.ok(noSource.correction)

  const cited = runData('上海成交均价上涨 3.2%（来源：克而瑞，贝壳成出口径，2026-07）。')
  assert.equal(cited.outcome, 'pass')

  const nullAsZero = runData('缺失数据按 null 转 0 处理。')
  assert.equal(nullAsZero.outcome, 'failed')
  assert.ok(nullAsZero.rounds[0].results[0].issues.some(i => i.code === 'null-as-zero'))

  const bareNull = runData('该指标缺失，记为 null。')
  assert.equal(bareNull.outcome, 'pass')

  const datesOnly = runData('数据期间 2026-07。')
  assert.equal(datesOnly.outcome, 'pass') // date-like tokens are not numeric claims

  const noRequire = runData('成交均价上涨 3.2%。', { requireCitation: false })
  assert.equal(noRequire.outcome, 'pass')
})

test('compliance: blocked identity, internal-only and deceased terms (historical allowed)', () => {
  const evaluators = createBuiltinGateEvaluators({
    compliance: { blockedTerms: ['张三'], internalOnlyTerms: ['bk-031'], deceasedTerms: ['顾云昌'] },
  })
  const runCompliance = (content) => run([gate('compliance-anonymization')], evaluators, content)

  const identity = runCompliance('张三认为市场见底。')
  assert.equal(identity.outcome, 'failed')
  const blocked = identity.rounds[0].results[0].issues.find(i => i.code === 'blocked-identity')
  assert.ok(blocked !== undefined)
  assert.equal(blocked.location, 'line 1')
  assert.ok(blocked.correction)

  const internal = runCompliance('bk-031 内测观点不得外发。')
  assert.equal(internal.outcome, 'failed')
  assert.ok(internal.rounds[0].results[0].issues.some(i => i.code === 'internal-only-exposed'))

  const current = runCompliance('顾云昌近期指出…')
  assert.equal(current.outcome, 'failed')
  assert.ok(current.rounds[0].results[0].issues.some(i => i.code === 'deceased-cited-as-current'))

  const historical = runCompliance('顾云昌（历史观点）曾指出市场分化。')
  assert.equal(historical.outcome, 'pass')
})

test('compliance terms can come from the gate config instead of options', () => {
  const result = run(
    [gate('compliance-anonymization', { config: { blockedTerms: ['李四'], deceasedTerms: ['王五'] } })],
    createBuiltinGateEvaluators(),
    '李四与王五近期判断…',
  )
  assert.equal(result.outcome, 'failed')
  const codes = result.rounds[0].results[0].issues.map(i => i.code)
  assert.ok(codes.includes('blocked-identity'))
  assert.ok(codes.includes('deceased-cited-as-current'))
})

test('style: phrase density warns; word limit errors but a soft gate only warns', () => {
  const runStyle = (content, config) => run(
    [gate('style-lint', { severity: 'soft', config })],
    createBuiltinGateEvaluators(),
    content,
  )

  const dense = runStyle('值得注意的是 A。值得注意的是 B。值得注意的是 C。值得注意的是 D。值得注意的是 E。值得注意的是 F。')
  assert.equal(dense.outcome, 'warn')
  assert.equal(dense.deliverableAllowed, true)
  const density = dense.rounds[0].results[0].issues.find(i => i.code === 'phrase-density')
  assert.ok(density !== undefined)
  assert.equal(density.severity, 'warning')

  // The word-limit evaluator yields an ERROR issue (result status fail), but
  // the gate itself is severity 'soft' — gate severity is authoritative: the
  // chain outcome is warn and delivery is allowed. Issue severity never
  // overrides gate severity (runtime unchanged).
  const long = runStyle('字'.repeat(3000), { maxWords: 1000 })
  assert.equal(long.outcome, 'warn')
  assert.equal(long.deliverableAllowed, true)
  assert.equal(long.rounds[0].status, 'fail') // round status reflects the failing result…
  const wordLimit = long.rounds[0].results[0].issues.find(i => i.code === 'word-limit-exceeded')
  assert.ok(wordLimit !== undefined)
  assert.equal(wordLimit.severity, 'error')
  assert.ok(wordLimit.evidence.includes('3000'))

  const ok = runStyle(`正常内容，${'数据'.repeat(10)}`, { maxWords: 100 })
  assert.equal(ok.outcome, 'pass')
})

test('style: a hard word-limit gate blocks delivery', () => {
  const result = run(
    [gate('style-lint', { severity: 'hard', config: { maxWords: 1000 } })],
    createBuiltinGateEvaluators(),
    '字'.repeat(3000),
  )
  assert.equal(result.outcome, 'failed')
  assert.equal(result.deliverableAllowed, false)
  const wordLimit = result.rounds[0].results[0].issues.find(i => i.code === 'word-limit-exceeded')
  assert.ok(wordLimit !== undefined)
  assert.equal(wordLimit.severity, 'error')
})

test('gate config wins over options (conservative config reuse)', () => {
  const evaluators = createBuiltinGateEvaluators({ sections: ['## 结论'] })
  const withConfig = run(
    [gate('schema-structure', { config: { sections: ['## 数据'] } })],
    evaluators,
    '## 数据\n3.2%（来源：克而瑞）。',
  )
  assert.equal(withConfig.outcome, 'pass') // config requires only '## 数据'

  const configDemands = run(
    [gate('schema-structure', { config: { sections: ['## 数据'] } })],
    evaluators,
    '## 结论\n只有结论。',
  )
  assert.equal(configDemands.outcome, 'failed')
  assert.ok(configDemands.rounds[0].results[0].issues.some(i => i.code === 'missing-section' && i.location === '## 数据'))
})

test('builtin map covers the deterministic ids and never fakes semantic/visual', () => {
  const builtins = createBuiltinGateEvaluators()
  for (const id of BUILTIN_DETERMINISTIC_GATE_IDS) {
    assert.equal(typeof builtins[id], 'function', `builtin evaluator for ${id}`)
  }
  for (const alias of ['structure', 'data', 'compliance', 'style']) {
    assert.equal(typeof builtins[alias], 'function', `alias ${alias}`)
  }
  const keys = Object.keys(builtins)
  assert.ok(!keys.some(key => key.includes('semantic') || key.includes('visual')), `no fake semantic/visual keys: ${keys.join(',')}`)
  assert.equal(builtins['semantic-fusion'], undefined)
})

test('zhijian quality policy executes with builtin evaluators; semantic stays injectable', () => {
  const pack = buildZhijianDomainPack()
  const policy = pack.qualityPolicies[0]
  const gates = policy.gates.map((spec, index) => ({
    id: `${policy.id}/${spec.id}`,
    kind: spec.kind,
    phase: spec.phase ?? 'structure',
    chainOrder: index,
    policyId: policy.id,
    policyVersion: policy.version,
    gateId: spec.id,
    severity: spec.severity,
    appliesTo: spec.appliesTo,
    ...(spec.config === undefined ? {} : { config: spec.config }),
  }))
  const content = '## 结论\n上海二手房市场 3.2% 上涨（来源：克而瑞，2026-07）。\n顾云昌（历史观点）曾指出市场分化。\n'
  // The policy gates applyTo ['deliverable']: the deliverable must be
  // resolvable, so supply deliverableSources (d1 composed from artifact d1)
  // — the runtime correctly fails with gate-artifact-missing otherwise.
  const deliverableSources = { d1: ['d1'] }

  // Deterministic gates execute; the hard semantic gate fails loudly with
  // gate-evaluator-missing instead of being faked.
  const withoutSemantic = run(gates, createBuiltinGateEvaluators(), content, { deliverableSources })
  assert.equal(withoutSemantic.outcome, 'failed')
  const semanticResult = withoutSemantic.rounds[0].results.find(r => r.gateId === 'semantic-fusion')
  assert.equal(semanticResult.status, 'fail')
  assert.equal(semanticResult.issues[0].code, 'gate-evaluator-missing')
  assert.equal(withoutSemantic.deliverableAllowed, false)

  // Injecting a real semantic evaluator makes the whole policy pass.
  const withSemantic = run(gates, {
    ...createBuiltinGateEvaluators(),
    'semantic-fusion': (input, ctx) => ({ gateId: 'semantic-fusion', status: 'pass', issues: [], evaluatedAt: ctx.now() }),
  }, content, { deliverableSources })
  assert.equal(withSemantic.outcome, 'pass')
  assert.equal(withSemantic.deliverableAllowed, true)
})

test('every issue carries code/severity; error issues carry location/evidence/correction', () => {
  const result = run(
    [gate('data-citation')],
    createBuiltinGateEvaluators(),
    '成交 3.2% 上涨。\n缺失记 null 转 0。',
  )
  const issues = result.rounds[0].results[0].issues
  assert.ok(issues.length >= 2)
  for (const issue of issues) {
    assert.ok(typeof issue.code === 'string' && issue.code.length > 0)
    assert.ok(issue.severity === 'error' || issue.severity === 'warning' || issue.severity === 'info')
    if (issue.severity === 'error') {
      assert.ok(issue.location !== undefined, `location for ${issue.code}`)
      assert.ok(issue.evidence !== undefined, `evidence for ${issue.code}`)
      assert.ok(issue.correction !== undefined, `correction for ${issue.code}`)
    }
  }
})
