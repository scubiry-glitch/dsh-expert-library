/**
 * V1 retirement step 2 tests — the generic builtin library's static V2 pack
 * home (`domain-packs/builtin-library/`):
 *
 * - the generator `--check` is clean (the committed pack == a fresh emit);
 * - the pack round-trips through the real loader validator-clean (8 generic
 *   experts only — zhijian bk-* stay in their own pack);
 * - every builtin scenario compiles with a **digest identical** to the
 *   adaptV1 projection path (pack-path vs adapt-path, 10/10);
 * - the runtime falls back to the projection when the pack dir is missing
 *   (injected bad path) and still compiles identically;
 * - the runtime cache is pack-first (generic experts are the loaded objects,
 *   not freshly adapted ones).
 * Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  compileV1ScenarioExecutionPlan,
  buildLegacyDomainPack,
  compileExecutionPlan,
  builtinLegacyPack,
  loadBuiltinLegacyPack,
  loadPackFromDir,
} from '../lib/v2/index.js'
import { BUILTIN_EXPERT_BY_ID } from '../lib/expert-library/builtin-experts.js'
import { BUILTIN_SCENARIO_BY_ID } from '../lib/expert-library/builtin-scenarios.js'
import { ZHIJIAN_EXPERT_BY_ID } from '../lib/zhijian/registry.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACK_DIR = join(REPO_ROOT, 'domain-packs/builtin-library')
const ALL_BUILTIN_EXPERTS = [...BUILTIN_EXPERT_BY_ID.values(), ...ZHIJIAN_EXPERT_BY_ID.values()]

/** The V1 roster assignment semantics (as documented in src/v2/compat.ts). */
function v1Assignments(scenario) {
  const assignments = {}
  for (const expertId of scenario.experts) {
    const slot = `role.${expertId}`
    if (assignments[slot] === undefined) assignments[slot] = [expertId]
  }
  for (const task of scenario.tasks) {
    if (task.expert === undefined) continue
    const slot = `role.${task.expert}`
    if (assignments[slot] === undefined) assignments[slot] = [task.expert]
  }
  if (scenario.tasks.some(task => task.expert === undefined)) assignments['role.shared'] = []
  return assignments
}

/** The pure adaptV1 projection path (pre-pack): fresh pack per scenario. */
function freshCompile(experts, scenario) {
  return compileExecutionPlan({
    pack: buildLegacyDomainPack({ experts, scenarios: [scenario] }),
    templateId: `${scenario.id}.legacy-team`,
    scenarioId: scenario.id,
    binding: { assignments: v1Assignments(scenario) },
  })
}

// ── 1. Generator drift guard ─────────────────────────────────────────────────

test('generator --check is clean (committed pack == a fresh emit)', () => {
  const out = execFileSync(process.execPath, ['scripts/build-builtin-pack.mjs', '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  assert.match(out, /CHECK CLEAN/)
})

// ── 2. Pack round-trip ───────────────────────────────────────────────────────

test('the builtin pack round-trips through the real loader validator-clean', async () => {
  const loaded = await loadPackFromDir(PACK_DIR)
  assert.equal(loaded.ok, true, loaded.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; '))
  assert.ok(loaded.pack !== undefined)
  assert.equal(loaded.pack.experts.length, BUILTIN_EXPERT_BY_ID.size, 'generic experts only — zhijian bk-* stay in their own pack')
  assert.equal(loaded.pack.scenarios.length, BUILTIN_SCENARIO_BY_ID.size)
  assert.equal(loaded.pack.teamTemplates.length, BUILTIN_SCENARIO_BY_ID.size)
  // The generated team templates are the legacy projections (same ids the
  // adaptV1 path derives), one per builtin scenario.
  const expectedTemplateIds = [...BUILTIN_SCENARIO_BY_ID.keys()].map(id => `${id}.legacy-team`).sort()
  assert.deepEqual(loaded.pack.teamTemplates.map(template => template.id), expectedTemplateIds)
  assert.equal(loaded.pack.knowledgeProviders.length, 1)
  assert.equal(loaded.pack.knowledgeProviders[0].id, 'local-knowledge')
})

// ── 3. Digest equality: pack path vs adaptV1 path (10/10) ───────────────────

test('every builtin scenario compiles digest-identically via the pack path and the adaptV1 path (10/10)', () => {
  for (const scenario of BUILTIN_SCENARIO_BY_ID.values()) {
    // pack-path: compileV1ScenarioExecutionPlan → builtinLegacyPack() (the
    // loaded static pack + appended zhijian experts).
    const packPath = compileV1ScenarioExecutionPlan(ALL_BUILTIN_EXPERTS, scenario)
    // adapt-path: the pre-cutover direct projection.
    const adaptPath = freshCompile(ALL_BUILTIN_EXPERTS, scenario)
    assert.equal(packPath.ok, true, `${scenario.id}: ${packPath.ok ? '' : JSON.stringify(packPath.errors)}`)
    assert.equal(adaptPath.ok, true, `${scenario.id}: ${adaptPath.ok ? '' : JSON.stringify(adaptPath.errors)}`)
    if (packPath.ok && adaptPath.ok) {
      assert.equal(packPath.plan.digest, adaptPath.plan.digest, `digest must match for ${scenario.id}`)
      assert.deepEqual(packPath.plan, adaptPath.plan)
    }
  }
})

// ── 4. Fallback when the pack dir is missing ─────────────────────────────────

test('fallback path still works when the pack dir is missing (injected bad path)', () => {
  const fallback = loadBuiltinLegacyPack('/definitely/not/a/real/pack')
  assert.equal(fallback.experts.length, BUILTIN_EXPERT_BY_ID.size + ZHIJIAN_EXPERT_BY_ID.size, 'fallback = full adaptV1 projection')
  // The fallback projection compiles a builtin scenario digest-identically to
  // the pack-loaded runtime cache.
  const scenario = BUILTIN_SCENARIO_BY_ID.get('market-research')
  const viaPack = compileV1ScenarioExecutionPlan(ALL_BUILTIN_EXPERTS, scenario)
  const viaFallback = compileExecutionPlan({
    pack: fallback,
    templateId: `${scenario.id}.legacy-team`,
    scenarioId: scenario.id,
    binding: { assignments: v1Assignments(scenario) },
  })
  assert.equal(viaPack.ok, true)
  assert.equal(viaFallback.ok, true)
  if (viaPack.ok && viaFallback.ok) {
    assert.equal(viaPack.plan.digest, viaFallback.plan.digest)
    assert.deepEqual(viaPack.plan, viaFallback.plan)
  }
})

// ── 5. Runtime is pack-first ─────────────────────────────────────────────────

test('builtinLegacyPack loads the static pack (not the projection) when the dir is present', () => {
  const cached = builtinLegacyPack()
  // Pack-first signature: the loader reads `experts/*.json` in sorted file
  // order, so the generic experts come back ALPHABETICAL — the direct
  // projection would preserve BUILTIN_EXPERT_BY_ID insertion order instead.
  const genericIds = cached.experts.filter(expert => !expert.id.startsWith('bk-')).map(expert => expert.id)
  assert.deepEqual(genericIds, [...BUILTIN_EXPERT_BY_ID.keys()].sort(), 'generic experts are the loaded pack entities (alphabetical)')
  assert.notDeepEqual(genericIds, [...BUILTIN_EXPERT_BY_ID.keys()], 'must NOT be the projection insertion order')
  // zhijian bk-* experts are appended from the V1 registry (their own pack).
  assert.equal(cached.experts.length, BUILTIN_EXPERT_BY_ID.size + ZHIJIAN_EXPERT_BY_ID.size)
  assert.ok(cached.experts.some(expert => expert.id === 'bk-024'))
  // The fallback projection is a different object than the cached pack.
  assert.notEqual(loadBuiltinLegacyPack('/definitely/not/a/real/pack'), cached)
})
