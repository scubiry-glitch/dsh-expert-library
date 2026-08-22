/**
 * schema-v2 regression tests: pack validation and the V1 adapter.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateDomainPack, buildLegacyDomainPack, adaptV1Expert } from '../lib/v2/index.js'

/** A minimal, fully valid pack used as the mutation base. */
function validPack() {
  return {
    pack: { id: 'demo-pack', version: '1.0.0', schemaVersion: 2, name: 'Demo' },
    experts: [
      {
        id: 'exp-1', version: '1.0.0', schemaVersion: 2,
        display: { internalName: '内部名', publicLabel: '公开标签', initials: 'GX' },
        domains: ['realestate'],
        capabilities: [{ capability: 'market.timeseries', proficiency: 4, coverage: 'high' }],
        persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [],
        compliance: {},
      },
    ],
    teamTemplates: [
      {
        id: 'tpl-1', version: '1.0.0', schemaVersion: 2,
        slots: [{ id: 'role.analyst', capabilities: ['market.timeseries'], cardinality: { min: 1, max: 1 } }],
        tasks: [
          {
            id: 't1', role: 'role.analyst', dependsOn: [], inputs: [], allowedCapabilities: [],
            outputSchema: 'out-1', retryPolicy: 'never', subject: '分析',
          },
          {
            id: 't2', role: 'role.analyst', dependsOn: ['t1'], inputs: [], allowedCapabilities: [],
            outputSchema: 'out-1', retryPolicy: 'quality-repair',
          },
        ],
        gates: [{ policy: 'quality-1', gate: 'schema', appliesTo: ['t2'] }],
        deliverables: [{ id: 'd1', outputTemplate: 'out-1', fromTasks: ['t2'] }],
      },
    ],
    outputTemplates: [
      {
        id: 'out-1', version: '1.0.0', schemaVersion: 2,
        media: ['markdown'],
        sections: [{ id: 'conclusion', required: true, maxWords: 300 }],
        renderModes: { discussion: { anonymize: true }, final: { anonymize: false } },
      },
    ],
    qualityPolicies: [
      {
        id: 'quality-1', version: '1.0.0', schemaVersion: 2,
        gates: [{ id: 'schema', kind: 'deterministic', appliesTo: ['conclusion'], severity: 'hard' }],
        maxRepairRounds: 2,
      },
    ],
    scenarios: [
      {
        id: 'scn-1', version: '1.0.0', schemaVersion: 2,
        domain: 'realestate', intents: ['monthly-review'],
        requiredCapabilities: [{ capability: 'market.timeseries', minProficiency: 3 }],
        routingPolicy: { assertions: [], candidateHints: ['exp-1'] },
        teamTemplate: 'tpl-1', outputTemplate: 'out-1', qualityPolicy: 'quality-1',
        knowledgePolicy: { required: ['local-knowledge'] },
        toolPolicy: { allowed: ['market.timeseries'] },
      },
    ],
    toolProviders: [
      {
        id: 'demo-provider', version: '1.0.0', schemaVersion: 2,
        capabilities: [{ capability: 'market.timeseries', operation: 'demo.query', transportId: 'cli-1' }],
        transports: [
          { kind: 'local-cli', id: 'cli-1', command: 'node', workingDirectory: '/opt/demo', timeoutMs: 30000, readOnly: true, auth: { credentialRef: 'DEMO_KEY' } },
        ],
      },
    ],
    knowledgeProviders: [
      {
        id: 'local-knowledge', version: '1.0.0', schemaVersion: 2, kind: 'files', capabilities: ['read'],
        freshness: 'static', domainKnowledgeIds: ['kb-realestate'],
      },
    ],
    domainKnowledge: [
      {
        id: 'kb-realestate', version: '1.0.0', schemaVersion: 2, domain: 'realestate.research',
        boundary: '中国房地产市场研究与政策解读资料',
        ontology: { entities: [{ id: 'city', description: '城市' }, { id: 'policy', description: '政策' }] },
        collections: [{ id: 'monthly-reports', root: 'collections/monthly-reports', format: 'markdown' }],
        snapshot: { id: 'snap-2026-08', takenAt: '2026-08-01T00:00:00Z', digest: 'b'.repeat(64), recordCount: 42 },
        retrievalProfiles: [{ id: 'kw', method: 'keyword' }],
        policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
      },
    ],
    methodPacks: [
      { id: 'method-1', version: '1.0.0', schemaVersion: 2, name: '评审方法', mediaType: 'agent-instructions', load: 'progressive', body: '步骤一…' },
    ],
    skillPackages: [
      {
        id: 'skill-1', version: '1.0.0', schemaVersion: 2,
        source: {
          kind: 'workspace', root: 'skills/skill-1', digest: 'a'.repeat(64), license: 'MIT',
          upstreamProvenance: { repository: 'https://github.com/owner/repo', revision: 'v1.0.0' },
        },
        contributions: { methodPacks: ['method-1'], toolRequirements: ['market.timeseries'] },
        permissions: { execScripts: [] },
      },
    ],
  }
}

test('valid pack passes with no error diagnostics', () => {
  const result = validateDomainPack(validPack())
  assert.equal(result.ok, true)
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0)
  assert.equal(result.value?.experts.length, 1)
})

test('duplicate expert id is reported as error with path', () => {
  const pack = validPack()
  pack.experts.push({ ...pack.experts[0] })
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  const dup = result.diagnostics.find(d => d.code === 'duplicate-id')
  assert.ok(dup !== undefined)
  assert.match(dup.path, /experts\[1\]\.id/)
})

test('scenario with dangling team template reference fails', () => {
  const pack = validPack()
  pack.scenarios[0].teamTemplate = 'tpl-404'
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  const ref = result.diagnostics.find(d => d.code === 'dangling-reference')
  assert.ok(ref !== undefined)
  assert.match(ref.path, /scenarios\[0\]\.teamTemplate/)
})

test('unknown task role and unknown dependency are both reported', () => {
  const pack = validPack()
  pack.teamTemplates[0].tasks[1].role = 'role.ghost'
  pack.teamTemplates[0].tasks[1].dependsOn = ['t404']
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  const codes = result.diagnostics.map(d => d.code)
  assert.ok(codes.includes('dangling-reference'), 'unknown role reported')
  assert.ok(codes.includes('dangling-dependency'), 'unknown dependency reported')
})

test('dependency cycle fails validation', () => {
  const pack = validPack()
  pack.teamTemplates[0].tasks[0].dependsOn = ['t2'] // t1 -> t2 -> t1
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'dag-cycle'))
})

test('proficiency out of the 1..5 range fails', () => {
  for (const bad of [0, 6, 3.5]) {
    const pack = validPack()
    pack.experts[0].capabilities[0].proficiency = bad
    const result = validateDomainPack(pack)
    assert.equal(result.ok, false, `proficiency ${bad} must fail`)
    assert.ok(result.diagnostics.some(d => d.code === 'proficiency-out-of-range'))
  }
})

test('expert with empty capabilities fails (capability-first routing)', () => {
  const pack = validPack()
  pack.experts[0].capabilities = []
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'empty-capabilities'))
})

test('skill package with dangling contribution and unknown tool requirement fails', () => {
  const pack = validPack()
  pack.skillPackages[0].contributions.methodPacks = ['method-404']
  pack.skillPackages[0].contributions.toolRequirements = ['capability.nobody-declares']
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  const refs = result.diagnostics.filter(d => d.code === 'dangling-reference')
  assert.ok(refs.some(d => d.path.includes('contributions.methodPacks')))
  assert.ok(refs.some(d => d.path.includes('contributions.toolRequirements')))
})

test('skill package without license must be internalOnly', () => {
  const pack = validPack()
  delete pack.skillPackages[0].source.license
  let result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'unlicensed-not-internal'))
  assert.ok(result.diagnostics.some(d => d.code === 'missing-license' && d.severity === 'warning'))
  pack.skillPackages[0].permissions.internalOnly = true
  result = validateDomainPack(pack)
  assert.equal(result.ok, true)
})

test('skill package contributions resolving inside the pack pass', () => {
  const pack = validPack()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true)
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), [])
})

test('remote skill sources are forbidden at runtime', () => {
  const pack = validPack()
  pack.skillPackages[0].source = {
    kind: 'git', // not builtin|workspace — must be rejected
    repo: 'owner/repo', ref: 'main', // legacy remote fields are not recognized
    root: 'skills/skill-1', digest: 'a'.repeat(64), license: 'MIT',
  }
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'invalid-field' && d.path.includes('source.kind')))
})

test('skill source root must stay a safe relative path', () => {
  for (const badRoot of ['../escape', '/absolute/skills', 'skills/../..', 'C:\\skills', 'skills//x']) {
    const pack = validPack()
    pack.skillPackages[0].source.root = badRoot
    const result = validateDomainPack(pack)
    assert.equal(result.ok, false, `root "${badRoot}" must fail`)
    assert.ok(result.diagnostics.some(d => d.code === 'invalid-field' && d.path.includes('source.root')), `root "${badRoot}" reported`)
  }
})

test('duplicate transport id and dangling capability transportId fail', () => {
  const pack = validPack()
  pack.toolProviders[0].transports.push({ kind: 'http-api', id: 'cli-1', baseUrl: 'https://api.example.com' })
  pack.toolProviders[0].capabilities[0].transportId = 'no-such-transport'
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'duplicate-transport-id'))
  assert.ok(result.diagnostics.some(d => d.code === 'dangling-transport'))
})

test('transport kind union is closed and per-kind fields required', () => {
  const pack = validPack()
  pack.toolProviders[0].transports = [
    { kind: 'ftp', id: 't-ftp' },
    { kind: 'mcp-stdio', id: 't-stdio' }, // missing command
    { kind: 'http-api', id: 't-api' }, // missing baseUrl
  ]
  pack.toolProviders[0].capabilities[0].transportId = undefined
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  const messages = result.diagnostics.filter(d => d.code === 'invalid-field').map(d => d.message)
  assert.ok(messages.some(m => m.includes('mcp-stdio|mcp-http|http-api|local-cli')))
  assert.ok(messages.some(m => m.includes('mcp-stdio transport needs a non-empty command')))
  assert.ok(messages.some(m => m.includes('http-api transport needs a non-empty baseUrl')))
})

test('method pack must be a progressive agent-instructions asset', () => {
  const pack = validPack()
  delete pack.methodPacks[0].mediaType
  delete pack.methodPacks[0].load
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'invalid-field' && d.path.includes('mediaType')))
  assert.ok(result.diagnostics.some(d => d.code === 'invalid-field' && d.path.includes('load')))
})

test('knowledge provider referencing an unknown domain knowledge base fails', () => {
  const pack = validPack()
  pack.knowledgeProviders[0].domainKnowledgeIds = ['kb-404']
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'dangling-reference' && d.path.includes('domainKnowledgeIds')))
})

test('domain knowledge collection root must not escape its root', () => {
  const pack = validPack()
  pack.domainKnowledge[0].collections[0].root = '../outside'
  const result = validateDomainPack(pack)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(d => d.code === 'invalid-field' && d.path.includes('collections[0].root')))
})

test('V1 adapter preserves id/name/model and marks legacy conservatively', () => {
  const v1 = {
    id: 'bk-004',
    name: '某专家',
    role: '行业研究',
    background: '背景',
    principles: ['原则一'],
    deliverables: ['月报'],
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    suitedFor: ['market-research'],
  }
  const v2 = adaptV1Expert(v1)
  assert.equal(v2.id, 'bk-004')
  assert.equal(v2.display.internalName, '某专家')
  assert.deepEqual(v2.modelPolicy, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.equal(v2.legacySource, 'v1')
  assert.ok(v2.capabilities.length > 0)
  for (const claim of v2.capabilities) {
    assert.equal(claim.legacySource, 'v1')
    assert.ok(claim.capability.startsWith('legacy.'), 'adapter must not invent real capabilities')
    assert.equal(claim.proficiency, 1)
  }
})

test('buildLegacyDomainPack keeps scenario task dependencies and validates clean', () => {
  const pack = buildLegacyDomainPack({
    experts: [
      { id: 'researcher', name: 'Researcher', role: 'research', background: 'b', principles: [], deliverables: [] },
    ],
    scenarios: [
      {
        id: 'market-research',
        name: 'Market Research',
        description: '调研',
        experts: ['researcher'],
        tasks: [
          { subject: '界定问题', dependsOn: [], expert: 'researcher' },
          { subject: '数据分析', dependsOn: [0], expert: 'researcher' },
          { subject: '调研报告', dependsOn: [1] },
        ],
        deliverable: '调研报告',
      },
    ],
  })
  // Task dependency structure survives the projection.
  const tasks = pack.teamTemplates[0].tasks
  assert.deepEqual(tasks.map(t => t.id), ['t1', 't2', 't3'])
  assert.deepEqual(tasks[1].dependsOn, ['t1'])
  assert.deepEqual(tasks[2].dependsOn, ['t2'])
  // Roles: expert-owned tasks get dedicated slots, shared task gets role.shared.
  assert.equal(tasks[0].role, 'role.researcher')
  assert.equal(tasks[2].role, 'role.shared')
  // The whole legacy view must pass the strict V2 validator.
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true)
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), [])
})
