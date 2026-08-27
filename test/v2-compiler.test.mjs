/**
 * Phase 3 `template-compiler` regression tests: deterministic immutable
 * ExecutionPlan, params/cardinality/capability/provider validation, and
 * isomorphic DAG for same template + same input.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileExecutionPlan,
  validateDomainPack,
  buildZhijianDomainPack,
  buildLegacyDomainPack,
  compileV1ScenarioExecutionPlan,
} from '../lib/v2/index.js'

/** A fully validator-clean demo pack used as the mutation base. */
function pack() {
  return {
    pack: { id: 'demo-pack', version: '1.0.0', schemaVersion: 2, name: 'Demo' },
    experts: [
      {
        id: 'exp-1', version: '1.0.0', schemaVersion: 2,
        display: { internalName: '专家一', publicLabel: '公开一', initials: 'A1' },
        domains: ['realestate'],
        capabilities: [
          { capability: 'market.timeseries', proficiency: 4, coverage: 'high' },
          { capability: 'realestate.indicator', proficiency: 3, coverage: 'medium' },
        ],
        persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [],
        compliance: {},
      },
      {
        id: 'exp-2', version: '1.0.0', schemaVersion: 2,
        display: { internalName: '专家二', publicLabel: '公开二', initials: 'B2' },
        domains: ['macro'],
        capabilities: [{ capability: 'market.timeseries', proficiency: 5, coverage: 'high' }],
        persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [],
        modelPolicy: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        compliance: {},
      },
      {
        id: 'exp-3', version: '1.0.0', schemaVersion: 2,
        display: { internalName: '已故专家', publicLabel: '公开三', initials: 'C3' },
        domains: ['realestate'],
        capabilities: [{ capability: 'market.timeseries', proficiency: 5, coverage: 'high' }],
        persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [],
        compliance: { deceased: true },
      },
      {
        id: 'exp-4', version: '1.0.0', schemaVersion: 2,
        display: { internalName: '融合专家', publicLabel: '公开四', initials: 'D4' },
        domains: ['synthesis'],
        capabilities: [{ capability: 'data.fusion', proficiency: 3, coverage: 'medium' }],
        persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [],
        compliance: {},
      },
    ],
    teamTemplates: [
      {
        id: 'tpl-monthly', version: '1.0.0', schemaVersion: 2,
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', minLength: 1 },
            period: { type: 'string', default: '2026-07' },
          },
          required: ['city'],
        },
        slots: [
          { id: 'role.analyst', capabilities: ['market.timeseries'], cardinality: { min: 1, max: 2 } },
          { id: 'role.fusion', capabilities: ['data.fusion'], cardinality: { min: 1, max: 1 } },
        ],
        tasks: [
          {
            id: 't1', role: 'role.analyst', dependsOn: [],
            inputs: [
              { kind: 'tool-capability', ref: 'market.timeseries' },
              { kind: 'parameter', ref: 'city' },
            ],
            allowedCapabilities: ['market.timeseries', 'realestate.deal.search'],
            outputSchema: 'out-1', retryPolicy: 'provider-only', subject: '采集',
          },
          {
            id: 't2', role: 'role.analyst', dependsOn: ['t1'],
            inputs: [{ kind: 'task-output', ref: 't1' }],
            allowedCapabilities: [],
            outputSchema: 'out-1', retryPolicy: 'never',
          },
          {
            id: 't3', role: 'role.fusion', dependsOn: ['t2'],
            inputs: [
              { kind: 'task-output', ref: 't2' },
              { kind: 'knowledge', ref: 'local-knowledge:monthly' },
            ],
            allowedCapabilities: ['data.fusion'],
            outputSchema: 'out-1', retryPolicy: 'quality-repair',
          },
        ],
        // Declared shuffled on purpose: chain order must come from phases,
        // not from declaration order.
        gates: [
          { policy: 'quality-1', gate: 'semantic', appliesTo: ['t3'] },
          { policy: 'quality-1', gate: 'schema', appliesTo: ['t3'] },
          { policy: 'quality-1', gate: 'data', appliesTo: ['t3'] },
        ],
        deliverables: [{ id: 'd1', outputTemplate: 'out-1', fromTasks: ['t3'] }],
      },
      {
        // A slot whose capability no expert claims: valid pack, uncompilable.
        id: 'tpl-broken', version: '1.0.0', schemaVersion: 2,
        slots: [{ id: 'role.ghost', capabilities: ['ghost.cap'], cardinality: { min: 1, max: 1 } }],
        tasks: [
          { id: 'g1', role: 'role.ghost', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' },
        ],
        gates: [],
        deliverables: [{ id: 'd9', outputTemplate: 'out-1', fromTasks: ['g1'] }],
      },
      {
        // One user-signoff slot (role.signoff) + one plain slot: the
        // selectedExpertIds param drives the sign-off slot's roster.
        id: 'tpl-signoff', version: '1.0.0', schemaVersion: 2,
        slots: [
          { id: 'role.signoff', capabilities: ['market.timeseries'], cardinality: { min: 1, max: 2 }, approval: 'user-signoff' },
          { id: 'role.helper', capabilities: ['market.timeseries'], cardinality: { min: 1, max: 1 } },
        ],
        tasks: [
          { id: 's1', role: 'role.signoff', dependsOn: [], inputs: [], allowedCapabilities: ['market.timeseries'], outputSchema: 'out-1', retryPolicy: 'never' },
          { id: 's2', role: 'role.helper', dependsOn: ['s1'], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' },
        ],
        gates: [],
        deliverables: [{ id: 'ds', outputTemplate: 'out-1', fromTasks: ['s2'] }],
      },
    ],
    outputTemplates: [
      {
        id: 'out-1', version: '1.0.0', schemaVersion: 2,
        media: ['markdown'],
        sections: [{ id: 'conclusion', required: true }],
        renderModes: { final: { anonymize: false } },
      },
    ],
    qualityPolicies: [
      {
        id: 'quality-1', version: '1.0.0', schemaVersion: 2,
        gates: [
          { id: 'semantic', kind: 'semantic', appliesTo: ['t3'], severity: 'soft', phase: 'semantic' },
          { id: 'schema', kind: 'deterministic', appliesTo: ['t3'], severity: 'hard', phase: 'structure' },
          { id: 'data', kind: 'deterministic', appliesTo: ['t3'], severity: 'hard', phase: 'data' },
        ],
        maxRepairRounds: 2,
      },
    ],
    scenarios: [
      {
        id: 'scn-1', version: '1.0.0', schemaVersion: 2,
        domain: 'realestate', intents: ['monthly-review'],
        requiredCapabilities: [{ capability: 'market.timeseries', minProficiency: 3 }],
        routingPolicy: { candidateHints: ['exp-1'] },
        teamTemplate: 'tpl-monthly', outputTemplate: 'out-1', qualityPolicy: 'quality-1',
        knowledgePolicy: { required: ['local-knowledge'] },
        toolPolicy: {
          allowed: ['market.timeseries', 'realestate.deal.search', 'data.fusion'],
          fallbacks: [{ from: 'realestate.deal.search', to: 'market.timeseries' }],
        },
      },
    ],
    toolProviders: [
      {
        id: 'wind-provider', version: '1.0.0', schemaVersion: 2,
        capabilities: [{ capability: 'market.timeseries', operation: 'wind.stock.snapshot', transportId: 'wind-http' }],
        transports: [{ kind: 'http-api', id: 'wind-http', baseUrl: 'https://mcp.wind.com.cn/vserver_stock_data/mcp/' }],
      },
      {
        id: 'zyt-provider', version: '1.0.0', schemaVersion: 2,
        capabilities: [{ capability: 'realestate.indicator', operation: 'zyt.indicators.series', transportId: 'zyt-http' }],
        transports: [{ kind: 'http-api', id: 'zyt-http', baseUrl: 'https://dss.ke.com/openapi/v1' }],
      },
      {
        id: 'local-tools', version: '1.0.0', schemaVersion: 2,
        capabilities: [{ capability: 'data.fusion', operation: 'local.fusion', transportId: 'local-cli' }],
        transports: [{ kind: 'local-cli', id: 'local-cli', command: 'node', workingDirectory: '/opt/demo' }],
      },
    ],
    knowledgeProviders: [
      {
        id: 'local-knowledge', version: '1.0.0', schemaVersion: 2, kind: 'files', capabilities: ['read'],
        freshness: 'static', scopes: ['monthly'],
      },
    ],
    domainKnowledge: [],
    methodPacks: [],
    skillPackages: [],
  }
}

function compile(p, params = { city: '上海' }, binding) {
  return compileExecutionPlan({
    pack: p,
    templateId: 'tpl-monthly',
    scenarioId: 'scn-1',
    params,
    ...(binding === undefined ? {} : { binding }),
  })
}

test('fixture pack is validator-clean', () => {
  const result = validateDomainPack(pack())
  assert.equal(result.ok, true)
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), [])
})

test('compiles into a frozen immutable plan with digest and topological order', () => {
  const result = compile(pack())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const plan = result.plan
  assert.match(plan.digest, /^[0-9a-f]{64}$/)
  assert.equal(plan.planId, `ep-${plan.digest.slice(0, 16)}`)
  assert.equal(plan.template.id, 'tpl-monthly')
  assert.deepEqual(plan.scenario, { id: 'scn-1', version: '1.0.0' })
  assert.deepEqual(plan.tasks.map(t => t.id), ['t1', 't2', 't3'])
  assert.deepEqual(plan.executionOrder, ['t1', 't2', 't3'])
  assert.equal(plan.tasks[2].retryPolicy, 'quality-repair')
  assert.deepEqual(plan.tasks[0].inputs, [
    { kind: 'tool-capability', ref: 'market.timeseries', providerId: 'wind-provider', operation: 'wind.stock.snapshot', transportId: 'wind-http' },
    { kind: 'parameter', ref: 'city', parameterKey: 'city' },
  ])
  assert.deepEqual(plan.tasks[2].inputs, [
    { kind: 'task-output', ref: 't2', fromTask: 't2' },
    { kind: 'knowledge', ref: 'local-knowledge:monthly', providerId: 'local-knowledge', scope: 'monthly' },
  ])
  // Immutability: every level is frozen.
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Object.isFrozen(plan.tasks), true)
  assert.equal(Object.isFrozen(plan.tasks[0]), true)
  assert.equal(Object.isFrozen(plan.roster[0]), true)
})

test('auto roster ranks by proficiency and excludes deceased experts', () => {
  const result = compile(pack())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const { roster } = result.plan
  assert.deepEqual(roster.map(m => m.slotId), ['role.analyst', 'role.fusion'])
  assert.equal(roster[0].expertId, 'exp-2') // 5×high beats exp-1's 4×high; exp-3 deceased skipped
  assert.deepEqual(roster[0].modelPolicy, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
  assert.equal(roster[1].expertId, 'exp-4')
  assert.equal(roster[0].approval, 'none')
})

test('same template + same input ⇒ isomorphic DAG and identical digest', () => {
  const a = compile(pack())
  const b = compile(pack())
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  if (!a.ok || !b.ok) return
  assert.deepEqual(a.plan, b.plan)
  assert.equal(a.plan.digest, b.plan.digest)
  assert.equal(a.plan.planId, b.plan.planId)
})

test('param key order does not change the digest (canonical params)', () => {
  const a = compile(pack(), { city: '上海', period: '2026-08' })
  const b = compile(pack(), { period: '2026-08', city: '上海' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  if (!a.ok || !b.ok) return
  assert.deepEqual(a.plan.params, b.plan.params)
  assert.equal(a.plan.digest, b.plan.digest)
})

test('params are deep-cloned into the plan (input mutation cannot leak)', () => {
  const params = { city: '上海', nested: { a: 1 } }
  const result = compile(pack(), params)
  assert.equal(result.ok, true)
  if (!result.ok) return
  params.nested.a = 99
  assert.equal(result.plan.params.nested.a, 1)
})

test('digest is sensitive to params', () => {
  const a = compile(pack(), { city: '上海' })
  const b = compile(pack(), { city: '北京' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  if (!a.ok || !b.ok) return
  assert.notEqual(a.plan.digest, b.plan.digest)
})

test('defaults are folded into normalized params', () => {
  const result = compile(pack(), { city: '上海' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.plan.params, { city: '上海', period: '2026-07' })
})

test('missing required param fails with params kind and is not retryable', () => {
  const result = compile(pack(), {})
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'params')
  const error = result.errors.find(e => e.code === 'params-required-missing')
  assert.ok(error !== undefined)
  assert.equal(error.kind, 'params')
  assert.equal(error.retryable, false)
})

test('non-object params are rejected', () => {
  const result = compileExecutionPlan({ pack: pack(), templateId: 'tpl-monthly', scenarioId: 'scn-1', params: 'nope' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'params-not-object'))
})

test('param type violations are reported', () => {
  const result = compile(pack(), { city: 123 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'params-type-mismatch'))
})

test('explicit assignments must satisfy slot cardinality', () => {
  const ok = compile(pack(), { city: '上海' }, { assignments: { 'role.analyst': ['exp-1', 'exp-2'] } })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.plan.roster.filter(m => m.slotId === 'role.analyst').map(m => m.expertId), ['exp-1', 'exp-2'])
  }
  const tooMany = compile(pack(), { city: '上海' }, { assignments: { 'role.analyst': ['exp-1', 'exp-2', 'exp-4'] } })
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) {
    assert.ok(tooMany.errors.some(e => e.code === 'assignment-count' && e.kind === 'roster'))
  }
  const tooFew = compile(pack(), { city: '上海' }, { assignments: { 'role.analyst': [] } })
  assert.equal(tooFew.ok, false)
  if (!tooFew.ok) {
    assert.ok(tooFew.errors.some(e => e.code === 'assignment-count'))
  }
})

test('expert must claim every slot capability', () => {
  const result = compile(pack(), { city: '上海' }, { assignments: { 'role.fusion': ['exp-1'] } })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'expert-not-qualified' && e.kind === 'roster'))
})

test('deceased experts cannot be rostered, only auto-skipped', () => {
  const explicit = compile(pack(), { city: '上海' }, { assignments: { 'role.analyst': ['exp-3'] } })
  assert.equal(explicit.ok, false)
  if (!explicit.ok) {
    assert.ok(explicit.errors.some(e => e.code === 'deceased-expert'))
  }
  const unknown = compile(pack(), { city: '上海' }, { assignments: { 'role.analyst': ['nobody'] } })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) {
    assert.ok(unknown.errors.some(e => e.code === 'unknown-expert'))
  }
})

test('undersupplied slot fails compilation (roster kind)', () => {
  const result = compileExecutionPlan({ pack: pack(), templateId: 'tpl-broken', params: {} })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'roster')
  assert.ok(result.errors.some(e => e.code === 'slot-undersupplied'))
})

test('unbound capability fails with binding kind and is retryable', () => {
  const p = pack()
  p.toolProviders = p.toolProviders.filter(provider => provider.id !== 'wind-provider')
  p.scenarios[0].toolPolicy.fallbacks = []
  const result = compile(p)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'binding')
  const error = result.errors.find(e => e.code === 'unbound-capability')
  assert.ok(error !== undefined)
  assert.equal(error.kind, 'binding')
  assert.equal(error.retryable, true)
})

test('scenario fallback resolves capability and records provenance', () => {
  const result = compile(pack())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const bound = result.plan.bindings.tool.find(b => b.capability === 'realestate.deal.search')
  assert.ok(bound !== undefined)
  assert.equal(bound.providerId, 'wind-provider')
  // Keyed by the requested capability; the served capability and the
  // substitution target are explicit.
  assert.equal(bound.capability, 'realestate.deal.search')
  assert.equal(bound.servedCapability, 'market.timeseries')
  assert.equal(bound.viaFallback, 'market.timeseries')
  assert.ok(result.plan.provenance.some(record => record.step === 'binding.fallback'))
  assert.ok(result.plan.provenance.some(record => record.step === 'roster.resolve'))
})

test('fallback binding stays keyed by the requested capability so task input lookup succeeds', () => {
  const p = pack()
  // t1 gains a tool-capability input for a capability that only resolves via
  // scenario fallback (realestate.deal.search → market.timeseries).
  p.teamTemplates[0].tasks[0].allowedCapabilities = ['market.timeseries', 'realestate.deal.search']
  p.teamTemplates[0].tasks[0].inputs = [
    { kind: 'tool-capability', ref: 'realestate.deal.search' },
    { kind: 'parameter', ref: 'city' },
  ]
  const result = compile(p)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const bound = result.plan.bindings.tool.find(b => b.capability === 'realestate.deal.search')
  assert.ok(bound !== undefined)
  assert.equal(bound.servedCapability, 'market.timeseries')
  assert.equal(bound.viaFallback, 'market.timeseries')
  // The compiled input resolves through the requested capability key.
  const input = result.plan.tasks[0].inputs.find(i => i.kind === 'tool-capability')
  assert.deepEqual(input, {
    kind: 'tool-capability',
    ref: 'realestate.deal.search',
    providerId: 'wind-provider',
    operation: 'wind.stock.snapshot',
    transportId: 'wind-http',
  })
})

test('explicit provider binding overrides resolution', () => {
  const result = compile(pack(), { city: '上海' }, {
    providerBindings: { 'market.timeseries': { providerId: 'wind-provider', transportId: 'wind-http' } },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const bound = result.plan.bindings.tool.find(b => b.capability === 'market.timeseries')
  assert.deepEqual(bound, { capability: 'market.timeseries', providerId: 'wind-provider', operation: 'wind.stock.snapshot', transportId: 'wind-http' })
})

test('provider binding to a provider that lacks the capability fails', () => {
  const result = compile(pack(), { city: '上海' }, {
    providerBindings: { 'market.timeseries': { providerId: 'zyt-provider' } },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'binding-provider-mismatch'))
})

test('unknown knowledge provider in an input binding fails', () => {
  const p = pack()
  p.teamTemplates[0].tasks[2].inputs[1] = { kind: 'knowledge', ref: 'ghost-kb:monthly' }
  const result = compile(p)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'unknown-knowledge-provider' && e.kind === 'binding'))
})

test('gate chain is ordered by phase, not by declaration order', () => {
  const result = compile(pack())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const gates = result.plan.gates
  assert.deepEqual(gates.map(g => g.gateId), ['schema', 'data', 'semantic'])
  assert.deepEqual(gates.map(g => g.chainOrder), [0, 1, 2])
  assert.deepEqual(gates.map(g => g.phase), ['structure', 'data', 'semantic'])
  assert.equal(gates[0].severity, 'hard')
  assert.equal(gates[2].severity, 'soft')
})

test('dangling dependency fails with template kind and is not retryable', () => {
  const p = pack()
  p.teamTemplates[0].tasks[1].dependsOn = ['ghost']
  const result = compile(p)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'template')
  const error = result.errors.find(e => e.code === 'dangling-dependency')
  assert.ok(error !== undefined)
  assert.equal(error.retryable, false)
})

test('dependency cycle fails compilation', () => {
  const p = pack()
  p.teamTemplates.push({
    id: 'tpl-cycle', version: '1.0.0', schemaVersion: 2,
    slots: [{ id: 'role.x', capabilities: ['market.timeseries'], cardinality: { min: 1, max: 1 } }],
    tasks: [
      { id: 'c1', role: 'role.x', dependsOn: ['c2'], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' },
      { id: 'c2', role: 'role.x', dependsOn: ['c1'], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' },
    ],
    gates: [],
    deliverables: [{ id: 'dc', outputTemplate: 'out-1', fromTasks: ['c1'] }],
  })
  const result = compileExecutionPlan({ pack: p, templateId: 'tpl-cycle', params: {} })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'dag-cycle'))
})

test('gate bindings to unknown policy/gate fail as template errors', () => {
  const p = pack()
  p.teamTemplates[0].gates[0].policy = 'quality-404'
  const result = compile(p)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'unknown-quality-policy' && e.kind === 'template'))
})

test('explicit render mode override lands on the deliverable', () => {
  const result = compile(pack(), { city: '上海' }, { renderMode: 'discussion' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.plan.deliverables[0].renderMode, 'discussion')
})

test('scenario mismatch is a warning, not an error', () => {
  const p = pack()
  p.scenarios[0].teamTemplate = 'tpl-broken'
  const result = compile(p)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.warnings.some(w => w.code === 'scenario-template-mismatch'))
})

/** A minimal template with one slot whose roster is controlled by the test. */
function rosterTemplate(id, capabilities, cardinality, diversity, taskIds = ['x1']) {
  return {
    id, version: '1.0.0', schemaVersion: 2,
    slots: [{ id: 'role.div', capabilities, cardinality, ...(diversity === undefined ? {} : { diversity }) }],
    tasks: taskIds.map((taskId, index) => ({
      id: taskId, role: 'role.div', dependsOn: taskIds.slice(0, index),
      inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never',
    })),
    gates: [],
    deliverables: [{ id: 'dd', outputTemplate: 'out-1', fromTasks: taskIds }],
  }
}

test('roster-only requiredCapabilities do not force a ToolProvider (zhijian pack)', () => {
  // buildZhijianDomainPack: requiredCapabilities are expert claims
  // (zhijian.review / <field>.review), toolPolicy.allowed is empty and
  // toolProviders is []. Compilation must succeed with zero tool bindings.
  // params.selectedExpertIds drives the unique user-signoff reviewer slot
  // (bk-024/bk-025 claim realestate.research.review, the monthly scenario's
  // primary field) — no lowest-id auto selection.
  const pack = buildZhijianDomainPack()
  const scenario = pack.scenarios.find(s => s.id === 'zhijian-monthly')
  assert.ok(scenario !== undefined, 'zhijian-monthly scenario present')
  const result = compileExecutionPlan({
    pack,
    templateId: scenario.teamTemplate, // zhijian.team.A
    scenarioId: scenario.id,
    params: { selectedExpertIds: ['bk-024', 'bk-025'], data: '上海 2026-07 二手房市场' },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.plan.bindings.tool, [])
  // Knowledge policy refs still bind (provider exists in the pack).
  assert.ok(result.plan.bindings.knowledge.some(k => k.ref === 'zhijian-expert-memory'))
  const reviewers = result.plan.roster.filter(m => m.slotId === 'role.reviewer')
  assert.deepEqual(reviewers.map(m => m.expertId), ['bk-024', 'bk-025'])
  assert.equal(reviewers[0].approval, 'user-signoff')
  assert.ok(!reviewers.some(m => m.expertId === 'bk-002'), 'selected ids win over lowest-id auto selection')
  // The logical reviewer task carries the selected ids for deterministic fan-out.
  const t1 = result.plan.tasks.find(t => t.id === 't1')
  const t2 = result.plan.tasks.find(t => t.id === 't2')
  const t3 = result.plan.tasks.find(t => t.id === 't3')
  assert.deepEqual(t1.expertIds, ['bk-024', 'bk-025'])
  // role.fusion is an optional slot (min 0): the fusion + render tasks stay in
  // the shared pool (unassigned), matching the V1 `expert_review_apply`
  // runtime — no auto-filled member is pinned to them.
  assert.deepEqual(t2.expertIds, [])
  assert.deepEqual(t3.expertIds, [])
  assert.deepEqual(t3.dependsOn, ['t2'])
  assert.deepEqual(result.plan.executionOrder, ['t1', 't2', 't3'])
})

test('diversity.fields grows the auto roster to distinct fields (up to cardinality.max)', () => {
  // role.div claims market.timeseries (exp-1 domains=[realestate], exp-2
  // domains=[macro]); fields:2 with min 1 → greedy picks exp-2 then grows to exp-1.
  const p = pack()
  p.teamTemplates.push(rosterTemplate(
    'tpl-div-auto',
    ['market.timeseries'],
    { min: 1, max: 2 },
    { fields: 2 },
  ))
  const result = compileExecutionPlan({ pack: p, templateId: 'tpl-div-auto', params: {} })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const members = result.plan.roster.filter(m => m.slotId === 'role.div').map(m => m.expertId)
  assert.deepEqual(members, ['exp-2', 'exp-1'])
})

test('diversity.fields fails when the pool cannot provide distinct fields', () => {
  // Only exp-4 claims data.fusion, with a single domain → fields:2 impossible.
  const p = pack()
  p.teamTemplates.push(rosterTemplate(
    'tpl-div-impossible',
    ['data.fusion'],
    { min: 1, max: 1 },
    { fields: 2 },
  ))
  const result = compileExecutionPlan({ pack: p, templateId: 'tpl-div-impossible', params: {} })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'roster')
  assert.ok(result.errors.some(e => e.code === 'diversity-fields-unsatisfied'))
})

test('diversity.fields is enforced for explicit assignments', () => {
  const p = pack()
  p.teamTemplates.push(rosterTemplate('tpl-div-explicit', ['market.timeseries'], { min: 1, max: 2 }, { fields: 2 }))
  // exp-1 (realestate) + exp-2 (macro) → two distinct domains → pass.
  const ok = compileExecutionPlan({
    pack: p,
    templateId: 'tpl-div-explicit',
    params: {},
    binding: { assignments: { 'role.div': ['exp-1', 'exp-2'] } },
  })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.plan.roster.filter(m => m.slotId === 'role.div').map(m => m.expertId), ['exp-1', 'exp-2'])
  }
  // exp-4 alone (single domain) → diversity violation.
  const bad = compileExecutionPlan({
    pack: p,
    templateId: 'tpl-div-explicit',
    params: {},
    binding: { assignments: { 'role.div': ['exp-1'] } },
  })
  assert.equal(bad.ok, false)
  if (!bad.ok) {
    assert.ok(bad.errors.some(e => e.code === 'diversity-fields-unsatisfied' && e.kind === 'roster'))
  }
})

test('roster must satisfy requiredCapabilities minProficiency (pass/fail threshold)', () => {
  // Pass: exp-2 claims market.timeseries at proficiency 5 ≥ 3.
  const pass = compile(pack())
  assert.equal(pass.ok, true)
  // Fail: raise the threshold above every rostered claim (exp-4 claims
  // data.fusion at 3, no other rostered expert claims it).
  const p = pack()
  p.scenarios[0].requiredCapabilities.push({ capability: 'data.fusion', minProficiency: 5 })
  const fail = compile(p)
  assert.equal(fail.ok, false)
  if (fail.ok) return
  assert.equal(fail.errorKind, 'roster')
  const error = fail.errors.find(e => e.code === 'required-capability-unsatisfied')
  assert.ok(error !== undefined)
  assert.match(error.message, /data\.fusion/)
  assert.match(error.message, /minProficiency 5/)
  // Lowering the threshold below the rostered claim passes again.
  p.scenarios[0].requiredCapabilities[1] = { capability: 'data.fusion', minProficiency: 2 }
  const ok = compile(p)
  assert.equal(ok.ok, true)
})

test('required capability missing from every rostered expert fails', () => {
  const p = pack()
  p.scenarios[0].requiredCapabilities.push({ capability: 'ghost.cap', minProficiency: 1 })
  const result = compile(p)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'roster')
  assert.ok(result.errors.some(e => e.code === 'required-capability-unsatisfied' && e.message.includes('ghost.cap')))
})

test('requiredCapabilities cardinality needs distinct rostered experts', () => {
  const p = pack()
  p.scenarios[0].requiredCapabilities.push({ capability: 'market.timeseries', minProficiency: 3, cardinality: 2 })
  // Auto roster fills role.analyst with a single expert (exp-2) → 1 distinct
  // claimant < 2.
  const auto = compile(p)
  assert.equal(auto.ok, false)
  if (!auto.ok) {
    assert.ok(auto.errors.some(e => e.code === 'required-capability-cardinality'))
  }
  // Explicit roster with two qualified claimants passes.
  const explicit = compile(p, { city: '上海' }, { assignments: { 'role.analyst': ['exp-1', 'exp-2'] } })
  assert.equal(explicit.ok, true)
})

test('requiredCapabilities.allowedProviders never forces a provider for roster capabilities', () => {
  const p = pack()
  // realestate.indicator is claimed by exp-1 (proficiency 3) but is NOT
  // tool-allowed; allowedProviders must not trigger any tool resolution.
  p.scenarios[0].requiredCapabilities.push({
    capability: 'realestate.indicator',
    minProficiency: 1,
    allowedProviders: ['wind-provider'],
  })
  const result = compile(p, { city: '上海' }, { assignments: { 'role.analyst': ['exp-1'] } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(!result.plan.bindings.tool.some(b => b.capability === 'realestate.indicator'), 'no provider forced for a roster-only capability')
  // Tool-allowed capabilities still bind as before.
  assert.ok(result.plan.bindings.tool.some(b => b.capability === 'market.timeseries'))
})

test('compiled tasks carry the resolved role roster expertIds for fan-out', () => {
  const result = compile(pack(), { city: '上海' }, { assignments: { 'role.analyst': ['exp-1', 'exp-2'] } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const byId = new Map(result.plan.tasks.map(task => [task.id, task]))
  assert.deepEqual(byId.get('t1').expertIds, ['exp-1', 'exp-2'])
  assert.deepEqual(byId.get('t2').expertIds, ['exp-1', 'exp-2']) // same role slot
  assert.deepEqual(byId.get('t3').expertIds, ['exp-4']) // fusion slot
})

test('params.selectedExpertIds drives the unique user-signoff slot', () => {
  const result = compileExecutionPlan({
    pack: pack(),
    templateId: 'tpl-signoff',
    params: { selectedExpertIds: ['exp-1', 'exp-2'] },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const signoff = result.plan.roster.filter(m => m.slotId === 'role.signoff')
  assert.deepEqual(signoff.map(m => m.expertId), ['exp-1', 'exp-2'])
  assert.equal(signoff[0].approval, 'user-signoff')
  assert.ok(result.plan.provenance.some(record => record.step === 'roster.param'))
  const s1 = result.plan.tasks.find(t => t.id === 's1')
  const s2 = result.plan.tasks.find(t => t.id === 's2')
  assert.deepEqual(s1.expertIds, ['exp-1', 'exp-2'])
  assert.deepEqual(s2.expertIds, ['exp-2']) // helper slot auto-fills
})

test('params.selectedExpertIds is validated like explicit assignments', () => {
  const run = (selectedExpertIds) => compileExecutionPlan({
    pack: pack(),
    templateId: 'tpl-signoff',
    params: { selectedExpertIds },
  })
  // Unqualified: exp-4 does not claim market.timeseries.
  const unqualified = run(['exp-1', 'exp-4'])
  assert.equal(unqualified.ok, false)
  if (!unqualified.ok) {
    assert.ok(unqualified.errors.some(e => e.code === 'expert-not-qualified'))
  }
  // Cardinality: 3 > max 2.
  const tooMany = run(['exp-1', 'exp-2', 'exp-4'])
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) {
    assert.ok(tooMany.errors.some(e => e.code === 'assignment-count'))
  }
  // Unknown id.
  const unknown = run(['nobody'])
  assert.equal(unknown.ok, false)
  if (!unknown.ok) {
    assert.ok(unknown.errors.some(e => e.code === 'unknown-expert'))
  }
  // Deceased expert rejected.
  const deceased = run(['exp-3'])
  assert.equal(deceased.ok, false)
  if (!deceased.ok) {
    assert.ok(deceased.errors.some(e => e.code === 'deceased-expert'))
  }
})

test('binding.assignments wins over params.selectedExpertIds for the sign-off slot', () => {
  const result = compileExecutionPlan({
    pack: pack(),
    templateId: 'tpl-signoff',
    params: { selectedExpertIds: ['exp-1'] },
    binding: { assignments: { 'role.signoff': ['exp-2'] } },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.plan.roster.filter(m => m.slotId === 'role.signoff').map(m => m.expertId), ['exp-2'])
})

test('selectedExpertIds is ignored when sign-off slots are ambiguous or absent', () => {
  // Two user-signoff slots → the param cannot be disambiguated; both auto-fill.
  const p = pack()
  p.teamTemplates.push({
    id: 'tpl-two-signoff', version: '1.0.0', schemaVersion: 2,
    slots: [
      { id: 'r1', capabilities: ['market.timeseries'], cardinality: { min: 1, max: 1 }, approval: 'user-signoff' },
      { id: 'r2', capabilities: ['market.timeseries'], cardinality: { min: 1, max: 1 }, approval: 'user-signoff' },
    ],
    tasks: [
      { id: 'a1', role: 'r1', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' },
      { id: 'a2', role: 'r2', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' },
    ],
    gates: [],
    deliverables: [{ id: 'da', outputTemplate: 'out-1', fromTasks: ['a1', 'a2'] }],
  })
  const ambiguous = compileExecutionPlan({ pack: p, templateId: 'tpl-two-signoff', params: { selectedExpertIds: ['exp-1'] } })
  assert.equal(ambiguous.ok, true)
  if (ambiguous.ok) {
    assert.deepEqual(ambiguous.plan.roster.filter(m => m.slotId === 'r1').map(m => m.expertId), ['exp-2'])
    assert.deepEqual(ambiguous.plan.roster.filter(m => m.slotId === 'r2').map(m => m.expertId), ['exp-2'])
    assert.ok(!ambiguous.plan.provenance.some(record => record.step === 'roster.param'))
  }
  // No user-signoff slot → the param is just a parameter; auto resolution stands.
  const plain = compile(pack(), { city: '上海', selectedExpertIds: ['exp-1'] })
  assert.equal(plain.ok, true)
  if (plain.ok) {
    assert.deepEqual(plain.plan.roster.filter(m => m.slotId === 'role.analyst').map(m => m.expertId), ['exp-2'])
  }
})

test('duplicate policy/gate bindings are deduped deterministically with a warning', () => {
  const p = pack()
  p.teamTemplates[0].gates.push({ policy: 'quality-1', gate: 'schema', appliesTo: ['t3'] }) // duplicate of the existing schema binding
  const result = compile(p)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.plan.gates.filter(g => g.gateId === 'schema').length, 1, 'schema bound exactly once')
  assert.deepEqual(result.plan.gates.map(g => g.chainOrder), [0, 1, 2])
  assert.ok(result.warnings.some(w => w.code === 'duplicate-gate-binding'))
})

test('tool-capability input must be in the task allowedCapabilities', () => {
  const p = pack()
  p.teamTemplates[0].tasks[0].inputs = [{ kind: 'tool-capability', ref: 'data.fusion' }] // t1 does not allow data.fusion
  const result = compile(p)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'tool-input-not-allowed' && e.message.includes('allowedCapabilities')))
})

test('tool-capability input must be in the scenario toolPolicy.allowed', () => {
  const p = pack()
  p.teamTemplates[0].tasks[0].allowedCapabilities = ['market.timeseries', 'realestate.deal.search', 'ghost.cap']
  p.teamTemplates[0].tasks[0].inputs = [{ kind: 'tool-capability', ref: 'ghost.cap' }]
  const result = compile(p)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(e => e.code === 'tool-input-not-allowed' && e.message.includes('toolPolicy.allowed')))
})

test('QualityGateSpec.phase is validated by the pack validator', () => {
  const p = pack()
  p.qualityPolicies[0].gates[0].phase = 'nonsense'
  const bad = validateDomainPack(p)
  assert.equal(bad.ok, false)
  assert.ok(bad.diagnostics.some(d => d.code === 'invalid-field' && d.path.includes('.phase')))
  // Valid phases and absent phase both pass.
  p.qualityPolicies[0].gates[0].phase = 'structure'
  const ok = validateDomainPack(p)
  assert.equal(ok.ok, true)
  delete p.qualityPolicies[0].gates[0].phase
  const absent = validateDomainPack(p)
  assert.equal(absent.ok, true)
})

test('auto roster fills zero experts for cardinality.min=0 (legacy shared slots stay shared-pool)', () => {
  const legacyExperts = [{ id: 'researcher', name: 'Researcher', role: 'research', background: 'b', principles: [], deliverables: [] }]
  const legacyScenario = {
    id: 'legacy-scn',
    name: 'Legacy',
    description: 'd',
    experts: ['researcher'],
    tasks: [
      { subject: 'expert task', dependsOn: [], expert: 'researcher' },
      { subject: 'shared task', dependsOn: [0] }, // expert-less → role.shared
    ],
    deliverable: 'd1',
  }
  const pack = buildLegacyDomainPack({ experts: legacyExperts, scenarios: [legacyScenario] })
  const template = pack.teamTemplates[0]

  // Raw auto resolution: min=0 slots select ZERO experts — the optional
  // legacy role.shared slot is never silently assigned an arbitrary expert.
  const auto = compileExecutionPlan({ pack, templateId: template.id, params: {} })
  assert.equal(auto.ok, true)
  if (!auto.ok) return
  const autoById = new Map(auto.plan.tasks.map(task => [task.id, task]))
  assert.deepEqual(autoById.get('t2').expertIds, [], 'shared task remains shared-pool (zero experts)')
  assert.deepEqual(autoById.get('t1').expertIds, [], 'min=0 expert slot also auto-fills zero without assignments')

  // Explicit assignments still fill a min=0 slot deterministically.
  const explicit = compileExecutionPlan({
    pack,
    templateId: template.id,
    params: {},
    binding: { assignments: { 'role.researcher': ['researcher'], 'role.shared': ['researcher'] } },
  })
  assert.equal(explicit.ok, true)
  if (!explicit.ok) return
  const explicitById = new Map(explicit.plan.tasks.map(task => [task.id, task]))
  assert.deepEqual(explicitById.get('t1').expertIds, ['researcher'])
  assert.deepEqual(explicitById.get('t2').expertIds, ['researcher'])

  // The V1→V2 bridge adapter fills expert slots explicitly and keeps
  // role.shared unassigned — the same M3 contract end to end.
  const bridged = compileV1ScenarioExecutionPlan(legacyExperts, legacyScenario)
  assert.equal(bridged.ok, true)
  if (!bridged.ok) return
  const bridgedById = new Map(bridged.plan.tasks.map(task => [task.id, task]))
  assert.deepEqual(bridgedById.get('t1').expertIds, ['researcher'])
  assert.deepEqual(bridgedById.get('t2').expertIds, [], 'bridge keeps role.shared in the shared pool')
})

test('unreferenced slots compile when explicitly assigned (V1 assembly roster)', () => {
  const experts = [
    { id: 'researcher', name: 'Researcher', role: 'research', background: 'b', principles: [], deliverables: [] },
    { id: 'analyst', name: 'Analyst', role: 'analysis', background: 'b', principles: [], deliverables: [] },
  ]
  const scenario = {
    id: 'legacy-scn',
    name: 'Legacy',
    description: 'd',
    experts: ['researcher', 'analyst'], // analyst owns no task
    tasks: [
      { subject: 'expert task', dependsOn: [], expert: 'researcher' },
      { subject: 'shared task', dependsOn: [0] },
    ],
    deliverable: 'd1',
  }
  const pack = buildLegacyDomainPack({ experts, scenarios: [scenario] })
  const template = pack.teamTemplates[0]

  // Unreferenced slot WITHOUT an explicit assignment stays skipped.
  const raw = compileExecutionPlan({ pack, templateId: template.id, params: {} })
  assert.equal(raw.ok, true)
  if (!raw.ok) return
  assert.ok(!raw.plan.roster.some(m => m.slotId === 'role.analyst'), 'unreferenced unassigned slot is skipped')

  // Explicit assignments compile the unreferenced slot into the roster.
  const explicit = compileExecutionPlan({
    pack,
    templateId: template.id,
    params: {},
    binding: { assignments: { 'role.researcher': ['researcher'], 'role.analyst': ['analyst'], 'role.shared': ['researcher'] } },
  })
  assert.equal(explicit.ok, true)
  if (!explicit.ok) return
  const analystMember = explicit.plan.roster.find(m => m.slotId === 'role.analyst')
  assert.ok(analystMember !== undefined, 'taskless expert is rostered via explicit assignment')
  assert.equal(analystMember.expertId, 'analyst')
  // The taskless expert is roster-only: no task carries its id.
  const explicitById = new Map(explicit.plan.tasks.map(task => [task.id, task]))
  assert.deepEqual(explicitById.get('t1').expertIds, ['researcher'])
  assert.deepEqual(explicitById.get('t2').expertIds, ['researcher'])

  // V1 bridge: scenario.experts entries are assembly-rostered even without a task.
  const bridged = compileV1ScenarioExecutionPlan(experts, scenario)
  assert.equal(bridged.ok, true)
  if (!bridged.ok) return
  const bridgedAnalyst = bridged.plan.roster.find(m => m.slotId === 'role.analyst')
  assert.ok(bridgedAnalyst !== undefined, 'V1 assembly roster keeps taskless experts')
  assert.equal(bridgedAnalyst.expertId, 'analyst')
  const bridgedById = new Map(bridged.plan.tasks.map(task => [task.id, task]))
  assert.deepEqual(bridgedById.get('t1').expertIds, ['researcher'])
  assert.deepEqual(bridgedById.get('t2').expertIds, [], 'shared task stays in the shared pool')
})

/** The fixture's data.fusion provider, kept so unrelated caps still bind. */
function localToolsProvider() {
  return {
    id: 'local-tools', version: '1.0.0', schemaVersion: 2,
    capabilities: [{ capability: 'data.fusion', operation: 'local.fusion', transportId: 'local-cli' }],
    transports: [{ kind: 'local-cli', id: 'local-cli', command: 'node', workingDirectory: '/opt/demo' }],
  }
}

test('auto-binding refuses explicitly writable transports without an explicit providerBinding', () => {
  const p = pack()
  p.toolProviders = [
    {
      id: 'write-provider', version: '1.0.0', schemaVersion: 2,
      capabilities: [{ capability: 'market.timeseries', operation: 'write.snapshot', transportId: 'write-cli' }],
      transports: [{ kind: 'local-cli', id: 'write-cli', command: 'node', readOnly: false }],
    },
    localToolsProvider(),
  ]
  const auto = compile(p)
  assert.equal(auto.ok, false)
  if (!auto.ok) {
    assert.equal(auto.errorKind, 'binding')
    const error = auto.errors.find(e => e.code === 'privileged-transport-requires-explicit-binding')
    assert.ok(error !== undefined, 'privileged-transport error reported')
    assert.equal(error.retryable, true)
    assert.ok(error.message.includes('readOnly:false'))
  }
  // Explicit providerBinding (produced by the CapabilityResolver/approval
  // layer) unlocks the privileged transport.
  const explicit = compile(p, { city: '上海' }, {
    providerBindings: { 'market.timeseries': { providerId: 'write-provider', transportId: 'write-cli' } },
  })
  assert.equal(explicit.ok, true)
})

test('auto-binding refuses credentialed transports (auth.credentialRef) without an explicit providerBinding', () => {
  const p = pack()
  p.toolProviders = [
    {
      id: 'auth-provider', version: '1.0.0', schemaVersion: 2,
      capabilities: [{ capability: 'market.timeseries', operation: 'auth.snapshot', transportId: 'auth-http' }],
      transports: [{ kind: 'http-api', id: 'auth-http', baseUrl: 'https://api.example.com', auth: { credentialRef: 'SECRET_KEY' } }],
    },
    localToolsProvider(),
  ]
  const auto = compile(p)
  assert.equal(auto.ok, false)
  if (!auto.ok) {
    const error = auto.errors.find(e => e.code === 'privileged-transport-requires-explicit-binding')
    assert.ok(error !== undefined, 'privileged-transport error reported')
    assert.ok(error.message.includes('credentialRef'))
  }
  const explicit = compile(p, { city: '上海' }, {
    providerBindings: { 'market.timeseries': { providerId: 'auth-provider', transportId: 'auth-http' } },
  })
  assert.equal(explicit.ok, true)
})

test('auto-binding remains for uncredentialed, non-writable transports', () => {
  const p = pack()
  // wind-provider: no auth, readOnly undefined → unprivileged → auto-binds.
  const result = compile(p)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.plan.bindings.tool.find(b => b.capability === 'market.timeseries'), {
    capability: 'market.timeseries', providerId: 'wind-provider', operation: 'wind.stock.snapshot', transportId: 'wind-http',
  })
  // Explicit readOnly: true is also not "explicitly writable" → still auto-bindable.
  const ro = pack()
  ro.toolProviders[0].transports[0].readOnly = true
  const resultRo = compile(ro)
  assert.equal(resultRo.ok, true)
})

test('auto-binding prefers unprivileged candidates over privileged ones', () => {
  const p = pack()
  // 'aaa-write' sorts before 'wind-provider' but is privileged (readOnly:false)
  // — the safe candidate must win deterministically.
  p.toolProviders.push({
    id: 'aaa-write', version: '1.0.0', schemaVersion: 2,
    capabilities: [{ capability: 'market.timeseries', operation: 'write.op', transportId: 'write-cli' }],
    transports: [{ kind: 'local-cli', id: 'write-cli', command: 'node', readOnly: false }],
  })
  const result = compile(p)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const bound = result.plan.bindings.tool.find(b => b.capability === 'market.timeseries')
  assert.equal(bound.providerId, 'wind-provider', 'unprivileged candidate wins over lower-id privileged one')
})
