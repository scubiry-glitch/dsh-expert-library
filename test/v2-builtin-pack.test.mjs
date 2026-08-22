/**
 * V1 retirement step 2/3 tests — the generic builtin library's static V2 pack
 * home (`domain-packs/builtin-library/`):
 *
 * - the generator `--check` is clean (the committed pack == a fresh emit);
 * - the pack round-trips through the real loader validator-clean (8 generic
 *   experts only — zhijian bk-* stay in their own pack);
 * - every builtin scenario compiles with a **digest identical** to the
 *   adaptV1 projection path (pack-path vs adapt-path, 10/10);
 * - step 3: a missing **or** invalid pack dir fails loudly with remediation
 *   (the adaptV1 runtime fallback is gone — no silent projection);
 * - the runtime cache is pack-first (generic experts are the loaded objects,
 *   not freshly adapted ones);
 * - the module-root-relative pack resolution works from a **published dist
 *   layout** (lib/ + domain-packs/ at the package root), not just the repo.
 * Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

// ── 4. No adaptV1 fallback: a missing/invalid pack fails loudly ──────────────

test('ppt-gen builtin DAG shape: the 渲染和出图 render task is the final node on docs-coordinator', () => {
  const scenario = BUILTIN_SCENARIO_BY_ID.get('ppt-gen')
  assert.ok(scenario !== undefined)
  if (scenario === undefined) return
  const tasks = scenario.tasks
  assert.equal(tasks.length, 4, 'ppt-gen must now carry the render task')
  const render = tasks[3]
  assert.equal(render?.subject, '渲染和出图')
  assert.deepEqual(render?.dependsOn, [2], 'render depends on the final copy/content task (逐页文案生成)')
  assert.equal(render?.expert, 'docs-coordinator', 'render uses the docs-coordinator render-role convention')
  const description = render?.description ?? ''
  assert.ok(description.includes('finesse-ui/SKILL.md'), 'instructs the finesse craft floor')
  assert.ok(description.includes('pptfast'), 'instructs the pptfast conversion')
  assert.ok(description.includes('video-shotcraft/SKILL.md'), 'instructs the video-shotcraft path')
  assert.ok(description.includes('goal/data'), 'scenario-level template note: 模板可由用户在 goal/data 参数中指定')
  // The video-shotcraft skill binding rides on the render task (final node).
  assert.equal(scenario.skill?.appliesToTaskIndex, 3)
  // The legacy projection compiles with the render task in the DAG, and the
  // pack-path digest still equals the adaptV1 projection (regen consistency).
  const compiled = compileV1ScenarioExecutionPlan(ALL_BUILTIN_EXPERTS, scenario)
  assert.equal(compiled.ok, true, compiled.ok ? '' : JSON.stringify(compiled.errors))
  if (!compiled.ok) return
  const plan = compiled.plan
  assert.deepEqual(plan.tasks.map(task => task.id), ['t1', 't2', 't3', 't4'])
  assert.deepEqual(plan.tasks.map(task => task.dependsOn), [[], ['t1'], ['t1', 't2'], ['t3']])
  assert.deepEqual(plan.tasks.map(task => task.subject), ['内容架构', '领域内容供给', '逐页文案生成', '渲染和出图'])
  assert.deepEqual(plan.tasks[3].role, 'role.docs-coordinator')
  assert.deepEqual(plan.deliverables[0].fromTasks, ['t1', 't2', 't3', 't4'])
  // pack-path == adapt-path digest stays byte-identical with the new node.
  const adaptPath = freshCompile(ALL_BUILTIN_EXPERTS, scenario)
  assert.equal(adaptPath.ok, true)
  if (adaptPath.ok) assert.equal(plan.digest, adaptPath.plan.digest)
})

test('a missing pack dir fails loudly with remediation (no adaptV1 fallback)', () => {
  assert.throws(
    () => loadBuiltinLegacyPack('/definitely/not/a/real/pack'),
    (error) => {
      assert.match(error.message, /builtin pack "\/definitely\/not\/a\/real\/pack" could not be loaded/)
      assert.match(error.message, /pack-root-missing/)
      assert.match(error.message, /pnpm build:builtin/)
      assert.match(error.message, /reinstall/)
      return true
    },
  )
})

test('an invalid pack dir fails loudly with remediation (no silent projection)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builtin-bad-pack-'))
  try {
    await writeFile(join(root, 'pack.json'), '{"not":"a pack"}')
    assert.throws(
      () => loadBuiltinLegacyPack(root),
      (error) => {
        assert.match(error.message, /could not be loaded/)
        assert.match(error.message, /pnpm build:builtin/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 5. Runtime is pack-first ─────────────────────────────────────────────────

test('builtinLegacyPack loads the static pack (not the projection) when the dir is present', () => {
  const cached = builtinLegacyPack()
  // Pack-first signature: the loader reads `experts/*.json` in sorted file
  // order, so the generic experts come back ALPHABETICAL — the direct
  // projection would preserve BUILTIN_EXPERT_BY_ID insertion order instead.
  const genericIds = cached.experts.filter(expert => !expert.id.startsWith('bk-') && !expert.id.startsWith('bank-')).map(expert => expert.id)
  assert.deepEqual(genericIds, [...BUILTIN_EXPERT_BY_ID.keys()].sort(), 'generic experts are the loaded pack entities (alphabetical)')
  assert.notDeepEqual(genericIds, [...BUILTIN_EXPERT_BY_ID.keys()], 'must NOT be the projection insertion order')
  // zhijian bk-* experts are appended from the V1 registry (their own pack).
  assert.equal(cached.experts.length, BUILTIN_EXPERT_BY_ID.size + ZHIJIAN_EXPERT_BY_ID.size)
  assert.ok(cached.experts.some(expert => expert.id === 'bk-024'))
})

// ── 6. Published dist layout ─────────────────────────────────────────────────

test('the builtin pack resolves from a published dist layout (lib/ + domain-packs/ at the package root)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builtin-dist-'))
  try {
    // Simulate the published package: lib/ + domain-packs/builtin-library/ at
    // the package root (the module-root-relative pack resolution must work
    // from the dist layout, exactly like the repo layout — both keep
    // lib/v2/compat.js two levels below the root).
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    await cp(join(REPO_ROOT, 'lib'), join(root, 'lib'), { recursive: true })
    await cp(join(REPO_ROOT, 'domain-packs', 'builtin-library'), join(root, 'domain-packs', 'builtin-library'), { recursive: true })
    const dist = await import(pathToFileURL(join(root, 'lib', 'v2', 'compat.js')).href)
    const cached = dist.builtinLegacyPack()
    assert.equal(cached.experts.length, BUILTIN_EXPERT_BY_ID.size + ZHIJIAN_EXPERT_BY_ID.size)
    const genericIds = cached.experts.filter(expert => !expert.id.startsWith('bk-') && !expert.id.startsWith('bank-')).map(expert => expert.id)
    assert.deepEqual(genericIds, [...BUILTIN_EXPERT_BY_ID.keys()].sort(), 'dist layout loads the shipped pack, not a projection')
    // The dist instance compiles a builtin scenario successfully.
    const compiled = dist.compileV1ScenarioExecutionPlan(ALL_BUILTIN_EXPERTS, BUILTIN_SCENARIO_BY_ID.get('code-review'))
    assert.equal(compiled.ok, true, compiled.ok ? '' : JSON.stringify(compiled.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
