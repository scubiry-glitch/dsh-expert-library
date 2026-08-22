/**
 * Phase 1 Zhijian V2 Domain Pack projection tests.
 *
 * Verifies that the 32 in-repo generated expert metas project into a
 * validator-clean `zhijian-realestate` DomainPackV2 with derived
 * output/team/scenario/quality assets — and that V1 runtime data is not
 * touched. Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  buildZhijianDomainPack,
  zhijianMetaToExpertV2,
  validateDomainPack,
  REVIEW_CAPABILITY,
  FIELD_DOMAINS,
  TAG_CAPABILITIES,
} from '../lib/v2/index.js'
import { ZHIJIAN_EXPERTS } from '../lib/zhijian/data/experts.generated.js'
import { ZHIJIAN_EXPERT_IDS, ZHIJIAN_EXPERT_BY_ID } from '../lib/zhijian/registry.js'

/** The V1 preset route (src/zhijian/registry.ts) — passed in explicitly by callers. */
const V1_ZHIJIAN_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }

function build() {
  return buildZhijianDomainPack({ modelPolicy: V1_ZHIJIAN_ROUTE })
}

/** Recursively check that no field carries the legacy adapter marker. */
function hasLegacyMarker(value, key = '') {
  if (Array.isArray(value)) return value.some(item => hasLegacyMarker(item, key))
  if (typeof value === 'object' && value !== null) {
    if ('legacySource' in value) return true
    return Object.entries(value).some(([k, v]) => hasLegacyMarker(v, k))
  }
  return false
}

// ── 1. Pack validity ─────────────────────────────────────────────────────────

test('zhijian pack validates clean with 32 experts', () => {
  const pack = build()
  const result = validateDomainPack(pack)
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter(d => d.severity === 'error')))
  assert.equal(result.diagnostics.filter(d => d.severity === 'error').length, 0)
  assert.equal(pack.experts.length, 32)
})

test('expert ids exactly match the V1 roster ids (bk-002..bk-033)', () => {
  const ids = build().experts.map(expert => expert.id)
  assert.deepEqual(ids, [...ZHIJIAN_EXPERT_IDS])
  assert.equal(ids[0], 'bk-002')
  assert.equal(ids[ids.length - 1], 'bk-033')
})

test('every derived expert maps 1:1 to a V1 Expert in the registry (runtime untouched)', () => {
  const pack = build()
  for (const expert of pack.experts) {
    const v1 = ZHIJIAN_EXPERT_BY_ID.get(expert.id)
    assert.ok(v1 !== undefined, `missing V1 expert ${expert.id}`)
    assert.equal(v1.name, expert.display.internalName)
  }
  assert.equal(ZHIJIAN_EXPERT_BY_ID.size, 32)
})

// ── 2. No fabrication / no legacy markers ────────────────────────────────────

test('pack contains no legacySource markers and no legacy initials placeholder', () => {
  const pack = build()
  assert.equal(hasLegacyMarker(pack), false, 'pack-projected objects must not be legacy-flagged')
  for (const expert of pack.experts) {
    assert.notEqual(expert.display.initials, 'legacy')
  }
})

test('capabilities derive only from roster-asserted field/tags, proficiency is the unassessed floor', () => {
  const allowed = new Set([
    REVIEW_CAPABILITY,
    ...Object.values(FIELD_DOMAINS).map(domain => `${domain}.review`),
    ...Object.values(TAG_CAPABILITIES),
  ])
  for (const expert of build().experts) {
    assert.ok(expert.capabilities.length > 0)
    for (const claim of expert.capabilities) {
      assert.ok(allowed.has(claim.capability), `unexpected capability ${claim.capability} on ${expert.id}`)
      assert.equal(claim.proficiency, 1, 'metas assert membership, not level — floor 1 only')
      assert.ok(claim.coverage === 'high' || claim.coverage === 'medium' || claim.coverage === 'low')
      assert.deepEqual(claim.evidenceRefs, ['zhijian:roster'])
      assert.equal(claim.legacySource, undefined)
    }
  }
})

test('primary field is high coverage, tags medium, secondary field low', () => {
  const pack = build()
  const byCapability = (expert, capability) => expert.capabilities.find(claim => claim.capability === capability)
  for (const expert of pack.experts) {
    const meta = ZHIJIAN_EXPERTS.find(item => item.id === expert.id)
    assert.ok(meta !== undefined)
    assert.equal(byCapability(expert, `${FIELD_DOMAINS[meta.field]}.review`)?.coverage, 'high')
    for (const tag of meta.tags) {
      assert.equal(byCapability(expert, TAG_CAPABILITIES[tag])?.coverage, 'medium')
    }
    if (meta.secondaryField !== undefined) {
      assert.equal(byCapability(expert, `${FIELD_DOMAINS[meta.secondaryField]}.review`)?.coverage, 'low')
    }
  }
})

// ── 3. Fidelity: persona/display/compliance mirror the metas verbatim ────────

test('display uses the already-anonymized personaName/initials, internal name is the real name', () => {
  for (const expert of build().experts) {
    const meta = ZHIJIAN_EXPERTS.find(item => item.id === expert.id)
    assert.ok(meta !== undefined)
    assert.equal(expert.display.internalName, meta.name)
    assert.equal(expert.display.publicLabel, meta.personaName)
    assert.equal(expert.display.initials, meta.initials)
    assert.notEqual(expert.display.publicLabel, expert.display.internalName, 'public label must stay anonymized')
    assert.ok(expert.display.initials.length >= 1 && expert.display.initials.length <= 2)
  }
})

test('persona fields mirror the generated meta verbatim (style/phrases/anti-patterns/models)', () => {
  for (const expert of build().experts) {
    const meta = ZHIJIAN_EXPERTS.find(item => item.id === expert.id)
    assert.ok(meta !== undefined)
    assert.deepEqual(expert.persona.style, [...meta.style])
    assert.deepEqual(expert.persona.signaturePhrases, [...meta.signaturePhrases])
    assert.deepEqual(expert.persona.antiPatterns, [...meta.antiPatterns])
    assert.deepEqual(
      (expert.persona.mentalModels ?? []).map(model => model.name),
      meta.mentalModels,
    )
  }
})

test('compliance assertions match the roster rules (deceased bk-022, internalOnly bk-031, caliber policies)', () => {
  const pack = build()
  for (const expert of pack.experts) {
    const compliance = expert.compliance
    if (expert.id === 'bk-022') assert.equal(compliance.deceased, true)
    else assert.equal(compliance.deceased, undefined)
    if (expert.id === 'bk-031') assert.equal(compliance.internalOnly, true)
    else assert.equal(compliance.internalOnly, undefined)
    if (expert.id === 'bk-024') assert.equal(compliance.citationPolicy, '克而瑞/普睿监测口径')
    if (expert.id === 'bk-025') assert.equal(compliance.citationPolicy, '中指院口径')
    if (expert.id === 'bk-031') assert.equal(compliance.citationPolicy, '贝壳/NIFD 口径')
  }
})

test('optional modelPolicy lands on every expert when supplied', () => {
  const pack = build()
  for (const expert of pack.experts) {
    assert.deepEqual(expert.modelPolicy, V1_ZHIJIAN_ROUTE)
  }
  const withoutRoute = buildZhijianDomainPack()
  for (const expert of withoutRoute.experts) {
    assert.equal(expert.modelPolicy, undefined, 'no route is asserted unless the caller supplies it')
  }
})

// ── 4. Derived assets: output/team/scenario/quality/method/knowledge ─────────

test('five output templates (A-E) derived from the framework specs', () => {
  const templates = build().outputTemplates
  assert.deepEqual(templates.map(template => template.id), ['zhijian.output.A', 'zhijian.output.B', 'zhijian.output.C', 'zhijian.output.D', 'zhijian.output.E'])
  const a = templates.find(template => template.id === 'zhijian.output.A')
  assert.deepEqual(a.renderModes, { discussion: { anonymize: true }, final: { anonymize: false } })
  // 约 500 字 ±10% → minWords 450 / maxWords 550
  assert.equal(a.sections.every(section => section.minWords === 450 && section.maxWords === 550), true)
  assert.deepEqual(a.media, ['markdown'])
})

test('four team templates (A-D) model one logical review → fusion render; E has none', () => {
  const templates = build().teamTemplates
  assert.deepEqual(templates.map(template => template.id), ['zhijian.team.A', 'zhijian.team.B', 'zhijian.team.C', 'zhijian.team.D'])
  for (const template of templates) {
    const tasks = template.tasks
    // One logical reviewer task + one fusion task (reviewer fan-out is the
    // execution adapter's job, driven by compiled task.expertIds).
    assert.deepEqual(tasks.map(task => task.id), ['t1', 't2'])
    assert.equal(tasks[0].role, 'role.reviewer')
    assert.equal(tasks[1].role, 'role.fusion')
    assert.deepEqual(tasks[1].dependsOn, ['t1'], 'fusion depends on the logical review task')
    assert.equal(template.slots[0].approval, 'user-signoff')
    assert.deepEqual(template.slots[0].cardinality, { min: 1, max: 5 })
    // role.fusion is optional (min 0): the fusion task stays unassigned
    // (shared pool), matching the V1 review runtime — no auto-filled member.
    assert.deepEqual(template.slots[1].cardinality, { min: 0, max: 1 })
    // The reviewer subject carries per-expert placeholders resolved by the
    // apply bridge from the adapter-supplied expertDisplay.
    assert.equal(tasks[0].subject, '专家研判：{expertName}（{expertField}·{expertInitials}）')
    // The runtime-shape params the review adapter folds into the compile.
    for (const param of ['dataContext', 'frameworkName', 'frameworkSteps', 'frameworkConstraints', 'wordLimitLine', 'frameworkWordLimitParen', 'outputFormText', 'fusionExtraRules']) {
      assert.ok(template.parameters.properties[param] !== undefined, `template must declare param ${param}`)
    }
    assert.ok(template.deliverables[0].outputTemplate.startsWith('zhijian.output.'))
    assert.deepEqual(template.deliverables[0].fromTasks, ['t2'])
    assert.ok(template.gates.length >= 2)
    assert.ok(template.gates.every(gate => gate.appliesTo.includes('t2')))
  }
  const d = templates.find(template => template.id === 'zhijian.team.D')
  assert.deepEqual(d.slots[0].diversity, { fields: 2 }, '框架 D 需要至少两个领域')
})

test('eight scenarios derived from the routing table with resolvable references', () => {
  const pack = build()
  const scenarios = pack.scenarios
  assert.deepEqual(scenarios.map(scenario => scenario.id), [
    'zhijian-monthly', 'zhijian-policy', 'zhijian-macro', 'zhijian-finance',
    'zhijian-city', 'zhijian-industry', 'zhijian-services', 'zhijian-institution',
  ])
  for (const scenario of scenarios) {
    assert.ok(pack.teamTemplates.some(template => template.id === scenario.teamTemplate))
    assert.ok(pack.outputTemplates.some(template => template.id === scenario.outputTemplate))
    assert.ok(pack.qualityPolicies.some(policy => policy.id === scenario.qualityPolicy))
    assert.ok(scenario.intents.length > 0)
    assert.ok(scenario.requiredCapabilities.length >= 1)
    assert.ok(scenario.routingPolicy.candidateHints.length > 0, 'candidates are routing hints')
    for (const hint of scenario.routingPolicy.candidateHints) {
      assert.ok(ZHIJIAN_EXPERT_IDS.includes(hint), `candidate ${hint} must exist in the roster`)
    }
  }
})

test('quality policy gates derive from the global output rules with repair cap 2', () => {
  const policy = build().qualityPolicies[0]
  assert.equal(policy.id, 'zhijian.quality')
  assert.equal(policy.maxRepairRounds, 2)
  const gateIds = policy.gates.map(gate => gate.id)
  for (const expected of ['schema-structure', 'data-citation', 'compliance-anonymization', 'style-lint', 'semantic-fusion']) {
    assert.ok(gateIds.includes(expected), `missing gate ${expected}`)
  }
  assert.ok(policy.gates.some(gate => gate.kind === 'semantic'))
  assert.ok(policy.gates.some(gate => gate.severity === 'soft'))
  // Explicit phases pin the deterministic chain order (§3.6).
  const phaseById = Object.fromEntries(policy.gates.map(gate => [gate.id, gate.phase]))
  assert.deepEqual(phaseById, {
    'schema-structure': 'structure',
    'data-citation': 'data',
    'compliance-anonymization': 'compliance',
    'style-lint': 'style',
    'semantic-fusion': 'semantic',
  })
})

test('method packs carry the framework methodology and the review protocol', () => {
  const pack = build()
  const methodIds = pack.methodPacks.map(method => method.id)
  for (const framework of ['a', 'b', 'c', 'd', 'e']) {
    assert.ok(methodIds.includes(`zhijian.method.framework-${framework}`))
  }
  assert.ok(methodIds.includes('zhijian.method.review-protocol'))
  for (const method of pack.methodPacks) {
    assert.equal(method.mediaType, 'agent-instructions')
    assert.equal(method.load, 'progressive')
    assert.ok(method.body.length > 0)
  }
})

test('knowledge providers and the domain knowledge manifest are self-describing', () => {
  const pack = build()
  const providerIds = pack.knowledgeProviders.map(provider => provider.id)
  assert.ok(providerIds.includes('local-knowledge'))
  assert.ok(providerIds.includes('zhijian-expert-memory'))
  const kb = pack.domainKnowledge[0]
  assert.equal(kb.id, 'zhijian.expert-memory')
  assert.equal(kb.snapshot.recordCount, 32)
  const expectedDigest = createHash('sha256').update(JSON.stringify(ZHIJIAN_EXPERTS)).digest('hex')
  assert.equal(kb.snapshot.digest, expectedDigest, 'snapshot digest is computed over the source metas')
  for (const expert of pack.experts) {
    assert.deepEqual(expert.knowledgeBindings[0], { providerId: 'zhijian-expert-memory', scope: `experts/${expert.id}` })
  }
})

// ── 5. Determinism / projection helpers ──────────────────────────────────────

test('two builds are byte-identical (deterministic projection)', () => {
  assert.deepEqual(build(), build())
  assert.deepEqual(buildZhijianDomainPack(), buildZhijianDomainPack())
})

test('zhijianMetaToExpertV2 maps a single meta with a custom pack version', () => {
  const meta = ZHIJIAN_EXPERTS.find(item => item.id === 'bk-004')
  assert.ok(meta !== undefined)
  const expert = zhijianMetaToExpertV2(meta, { packVersion: '2.0.0' })
  assert.equal(expert.id, 'bk-004')
  assert.equal(expert.version, '2.0.0')
  assert.equal(expert.schemaVersion, 2)
  assert.deepEqual(expert.domains, ['realestate.macro', 'realestate.research'], 'bk-004 主领域宏观经济 + 辅领域行业研究')
})

test('the pack never mutates the source metas (V1 runtime data untouched)', () => {
  const before = JSON.stringify(ZHIJIAN_EXPERTS)
  build()
  buildZhijianDomainPack()
  assert.equal(JSON.stringify(ZHIJIAN_EXPERTS), before)
})
