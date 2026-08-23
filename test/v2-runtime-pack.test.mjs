/**
 * Runtime Domain Pack resolver regression tests (audit gap #6 runtime half):
 * workspace `domain-packs/` packs now drive the compile path — merged over a
 * caller base pack with the canonical `builtin < workspace` precedence,
 * selectable by `enabledPacks` and ordered by `packPriority`, cached by
 * selection + dir fingerprint, invalidatable.
 *
 * Also covers the V1 scenario compile overlay (`compileV1ScenarioExecutionPlan`
 * with a resolved base pack) so workspace experts override builtins by id.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveRuntimePack,
  invalidateRuntimePack,
  compileV1ScenarioExecutionPlan,
  buildZhijianDomainPack,
} from '../lib/v2/index.js'

/** Minimal duck-typed ctx exposing only the workspace/sessions services. */
function fakeCtx(workspaces = [], sessions = []) {
  return {
    get(key) {
      if (key === 'workspaceRegistry' || key === 'workspace') {
        return { list: () => workspaces.map((path) => ({ path })) }
      }
      if (key === 'sessions') {
        return { list: () => sessions.map((cwd) => ({ header: { cwd } })) }
      }
      return undefined
    },
  }
}

/** Temp-dir helper that always cleans up. */
async function withTmp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-pack-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function expert(id, version = '1.0.0', extra = {}) {
  return {
    id, version, schemaVersion: 2,
    display: { internalName: `N-${id}`, publicLabel: `P-${id}`, initials: id.slice(0, 1) },
    domains: ['demo'],
    capabilities: [{ capability: 'demo.cap', proficiency: 3, coverage: 'medium' }],
    persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [], compliance: {},
    ...extra,
  }
}

/** Minimal validator-clean pack used as the base or a workspace pack. */
function validPack(id, { experts = [expert('ex-a')], overrides = {} } = {}) {
  return {
    pack: { id, version: '1.0.0', schemaVersion: 2, name: id.toUpperCase() },
    experts,
    teamTemplates: [
      {
        id: 'tpl-1', version: '1.0.0', schemaVersion: 2,
        slots: [{ id: 'role.a', capabilities: ['demo.cap'], cardinality: { min: 1, max: 1 } }],
        tasks: [{ id: 't1', role: 'role.a', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'out-1', retryPolicy: 'never' }],
        gates: [],
        deliverables: [{ id: 'd1', outputTemplate: 'out-1', fromTasks: ['t1'] }],
      },
    ],
    outputTemplates: [
      { id: 'out-1', version: '1.0.0', schemaVersion: 2, media: ['markdown'], sections: [{ id: 's1', required: true }], renderModes: { final: { anonymize: false } } },
    ],
    qualityPolicies: [
      { id: 'q-1', version: '1.0.0', schemaVersion: 2, gates: [{ id: 'schema', kind: 'deterministic', appliesTo: ['s1'], severity: 'hard' }], maxRepairRounds: 2 },
    ],
    scenarios: [
      {
        id: 'scn-1', version: '1.0.0', schemaVersion: 2, domain: 'demo', intents: ['x'],
        requiredCapabilities: [], routingPolicy: { candidateHints: ['ex-a'] },
        teamTemplate: 'tpl-1', outputTemplate: 'out-1', qualityPolicy: 'q-1',
        knowledgePolicy: { required: [] }, toolPolicy: { allowed: [] },
      },
    ],
    toolProviders: [], knowledgeProviders: [{
      id: 'local-knowledge', version: '1.0.0', schemaVersion: 2,
      kind: 'files', capabilities: ['read'], freshness: 'static',
      scopes: ['experts', 'scenarios', 'shared'],
    }], domainKnowledge: [], methodPacks: [], skillPackages: [],
    ...overrides,
  }
}

/** Write one workspace pack dir: `domain-packs/<id>/pack.json` + experts/. */
async function writeWorkspacePack(root, id, pack, { dirName = id } = {}) {
  const dir = join(root, 'domain-packs', dirName)
  await mkdir(join(dir, 'experts'), { recursive: true })
  await writeFile(join(dir, 'pack.json'), JSON.stringify(pack.pack), 'utf8')
  for (const entity of pack.experts) {
    await writeFile(join(dir, 'experts', `${entity.id}.json`), JSON.stringify(entity), 'utf8')
  }
  return dir
}

// --- Resolution basics -------------------------------------------------------

test('no workspace packs: runtime pack equals the base pack', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    const result = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    assert.equal(result.pack.pack.id, 'base')
    assert.equal(result.pack.experts.length, base.experts.length)
    assert.deepEqual(result.layers, [])
  })
})

test('workspace pack experts override the base by id (builtin < workspace)', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    await writeWorkspacePack(root, 'overlay', validPack('overlay', {
      experts: [expert('ex-a', '2.0.0', { display: { internalName: 'OVERRIDDEN', publicLabel: 'P2', initials: 'O' } })],
    }))
    const result = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    assert.equal(result.pack.pack.id, 'base') // base pack metadata wins (builtin layer)
    const exA = result.pack.experts.find(expert => expert.id === 'ex-a')
    assert.equal(exA.display.internalName, 'OVERRIDDEN')
    assert.equal(exA.version, '2.0.0')
    assert.equal(result.layers.length, 1)
  })
})

test('enabledPacks filters which workspace packs participate', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    await writeWorkspacePack(root, 'overlay-a', validPack('overlay-a', {
      experts: [expert('ex-a', '2.0.0')],
    }))
    await writeWorkspacePack(root, 'overlay-b', validPack('overlay-b', {
      experts: [expert('ex-b', '2.0.0')],
    }))
    // Only overlay-a enabled: ex-b must NOT appear.
    const result = await resolveRuntimePack(ctx, { packsDir: 'domain-packs', enabledPacks: ['overlay-a'] }, base)
    const ids = result.pack.experts.map(expert => expert.id)
    assert.ok(ids.includes('ex-a'))
    assert.ok(!ids.includes('ex-b'))
    assert.equal(result.layers.length, 1)
  })
})

test('empty enabledPacks = every valid workspace pack participates', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    await writeWorkspacePack(root, 'overlay-a', validPack('overlay-a', { experts: [expert('ex-a', '2.0.0')] }))
    await writeWorkspacePack(root, 'overlay-b', validPack('overlay-b', { experts: [expert('ex-b', '2.0.0')] }))
    const result = await resolveRuntimePack(ctx, { packsDir: 'domain-packs', enabledPacks: [] }, base)
    const ids = result.pack.experts.map(expert => expert.id)
    assert.ok(ids.includes('ex-a') && ids.includes('ex-b'))
    assert.equal(result.layers.length, 2)
  })
})

test('packPriority orders workspace layers (first = highest precedence)', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    await writeWorkspacePack(root, 'overlay-a', validPack('overlay-a', {
      experts: [expert('ex-a', '2.0.0', { display: { internalName: 'FROM-A', publicLabel: 'P2', initials: 'A' } })],
    }))
    await writeWorkspacePack(root, 'overlay-b', validPack('overlay-b', {
      experts: [expert('ex-a', '3.0.0', { display: { internalName: 'FROM-B', publicLabel: 'P3', initials: 'B' } })],
    }))
    // Default discovery order: overlay-a sorts before overlay-b; last loaded
    // (b) wins. With packPriority [b, a] (a first = highest), a must win.
    const result = await resolveRuntimePack(ctx, {
      packsDir: 'domain-packs',
      packPriority: ['overlay-b', 'overlay-a'],
    }, base)
    const exA = result.pack.experts.find(expert => expert.id === 'ex-a')
    assert.equal(exA.display.internalName, 'FROM-A')
    assert.equal(exA.version, '2.0.0')
  })
})

test('broken workspace pack degrades to diagnostics, never fatal', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    // A workspace pack dir whose pack.json is metadata-only WITHOUT the
    // required pack fields fails validation → loader reports diagnostics.
    await mkdir(join(root, 'domain-packs', 'broken', 'experts'), { recursive: true })
    await writeFile(
      join(root, 'domain-packs', 'broken', 'pack.json'),
      JSON.stringify({ id: 'broken' }),
      'utf8',
    )
    const result = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    assert.equal(result.pack.pack.id, 'base')
    assert.ok(result.diagnostics.length > 0)
  })
})

test('cache: same selection + fingerprint returns identical frozen result', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    await writeWorkspacePack(root, 'overlay', validPack('overlay', { experts: [expert('ex-a', '2.0.0')] }))
    const first = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    const second = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    assert.equal(first.pack, second.pack) // same frozen object (cache hit)
    // A different selection key must rebuild.
    const filtered = await resolveRuntimePack(ctx, { packsDir: 'domain-packs', enabledPacks: ['nope'] }, base)
    assert.notEqual(filtered.pack, first.pack)
  })
})

// --- V1 scenario compile overlay ----------------------------------------------

test('compileV1ScenarioExecutionPlan accepts a resolved base pack (workspace overlay)', () => {
  const overlay = validPack('overlay', { experts: [expert('ex-a', '2.0.0')] })
  // V1 experts list: one expert the base overlay defines with a preset model.
  const v1Experts = [{
    id: 'ex-a', name: 'Overlay Expert', role: 'analyst', background: 'b',
    principles: [], deliverables: [], model: { provider: 'p', model: 'm' },
  }]
  const scenario = {
    id: 'scn-1', name: 'S', description: 'd', experts: ['ex-a'],
    tasks: [{ subject: 't1', expert: 'ex-a' }], deliverable: 'out',
  }
  const compiled = compileV1ScenarioExecutionPlan(v1Experts, scenario, overlay)
  assert.equal(compiled.ok, true)
  assert.ok(compiled.plan.roster.some(member => member.expertId === 'ex-a'))
})

test('resolveRuntimePack feeds the zhijian pack without breaking its validity', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = buildZhijianDomainPack()
    const result = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    assert.equal(result.pack.pack.id, 'zhijian-realestate')
    assert.ok(result.pack.experts.length >= base.experts.length)
    // Deterministic: same base + no workspace packs → same expert set.
    assert.deepEqual(result.pack.experts.map(e => e.id).sort(), base.experts.map(e => e.id).sort())
  })
})

test('invalidateRuntimePack drops the cache', async () => {
  await withTmp(async (root) => {
    const ctx = fakeCtx([root])
    const base = validPack('base')
    const first = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    invalidateRuntimePack()
    const second = await resolveRuntimePack(ctx, { packsDir: 'domain-packs' }, base)
    assert.notEqual(first.pack, second.pack)
  })
})
