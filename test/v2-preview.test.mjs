/**
 * Read-only Domain Pack preview regression tests: the builtin pack projection,
 * workspace `domain-packs/` discovery, list summaries (health + counts) and
 * per-pack preview payloads (ok/diagnostics/pack presence invariants).
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  builtinLoadedPack,
  discoverPackDirsIn,
  listDomainPacks,
  packFromJson,
  previewDomainPack,
  summarizePack,
} from '../lib/v2/index.js'
import { ZHIJIAN_PACK_ID, ZHIJIAN_PACK_SNAPSHOT } from '../lib/v2/index.js'

/** A minimal, fully validator-clean pack used as the fixture base. */
function validPack(overrides = {}) {
  return {
    pack: { id: 'demo', version: '1.0.0', schemaVersion: 2, name: 'Demo' },
    experts: [expert('ex-a', '1.0.0'), expert('ex-b', '1.0.0')],
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
    toolProviders: [],
    knowledgeProviders: [],
    domainKnowledge: [],
    methodPacks: [],
    skillPackages: [],
    ...overrides,
  }
}

function expert(id, version) {
  return {
    id, version, schemaVersion: 2,
    display: { internalName: id, publicLabel: `P${id}`, initials: id.slice(0, 1) },
    domains: ['demo'],
    capabilities: [{ capability: 'demo.cap', proficiency: 3, coverage: 'medium' }],
    persona: {}, methods: [], knowledgeBindings: [], toolAffinities: [], compliance: {},
  }
}

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
  const root = await mkdtemp(join(tmpdir(), 'v2-preview-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Write one workspace pack dir: `domain-packs/<id>/pack.json` + experts. */
async function writeWorkspacePack(root, id, { broken = false } = {}) {
  const dir = join(root, 'domain-packs', id)
  await mkdir(join(dir, 'experts'), { recursive: true })
  if (broken) {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({ id }), 'utf8')
  } else {
    await writeFile(
      join(dir, 'pack.json'),
      JSON.stringify({ id, version: '1.0.0', schemaVersion: 2, name: id.toUpperCase() }),
      'utf8',
    )
    await writeFile(join(dir, 'experts', 'ex-a.json'), JSON.stringify(expert('ex-a', '1.0.0')), 'utf8')
  }
  return dir
}

// --- Builtin pack -------------------------------------------------------------

test('builtin pack loads as validator-clean and summarizes without profile prose', () => {
  const loaded = builtinLoadedPack()
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics))
  assert.equal(loaded.source.layer, 'builtin')
  assert.equal(loaded.source.label, `builtin/${ZHIJIAN_PACK_ID}`)
  const summary = summarizePack(loaded, { snapshot: ZHIJIAN_PACK_SNAPSHOT })
  assert.equal(summary.id, ZHIJIAN_PACK_ID)
  assert.equal(summary.version, '1.1.0')
  assert.equal(summary.snapshot, ZHIJIAN_PACK_SNAPSHOT)
  assert.equal(summary.ok, true)
  assert.equal(summary.errorCount, 0)
  assert.equal(summary.counts.experts, 33)
  // The wire summary never carries persona/profile prose.
  assert.ok(!('persona' in summary))
  assert.ok(!('capabilities' in summary))
  assert.ok(!('display' in summary))
})

// --- summarizePack ------------------------------------------------------------

test('summarizePack maps a loaded pack to counts, provenance and health', () => {
  const loaded = packFromJson(validPack(), { layer: 'domain-pack', label: 'domain-packs/demo', root: '/tmp/demo' })
  assert.equal(loaded.ok, true)
  const summary = summarizePack(loaded)
  assert.equal(summary.id, 'demo')
  assert.equal(summary.layer, 'domain-pack')
  assert.equal(summary.label, 'domain-packs/demo')
  assert.equal(summary.root, '/tmp/demo')
  assert.equal(summary.ok, true)
  assert.equal(summary.counts.experts, 2)
  assert.equal(summary.counts.scenarios, 1)
  assert.equal(summary.counts.teamTemplates, 1)
  assert.equal(summary.counts.outputTemplates, 1)
  assert.equal(summary.counts.qualityPolicies, 1)
  assert.equal(summary.counts.toolProviders, 0)
})

test('summarizePack of a broken pack keeps ok=false and falls back to the root id', () => {
  const pack = validPack()
  pack.experts.push(pack.experts[0]) // duplicate id → error
  const loaded = packFromJson(pack, { layer: 'workspace', label: 'domain-packs/broken', root: '/tmp/broken' })
  assert.equal(loaded.ok, false)
  const summary = summarizePack(loaded)
  assert.equal(summary.id, 'broken')
  assert.equal(summary.ok, false)
  assert.ok(summary.errorCount >= 1)
  assert.equal(summary.counts.experts, 0)
})

// --- Discovery ----------------------------------------------------------------

test('discoverPackDirsIn lists SafeId dirs and skips unsafe, files and missing roots', async () => {
  await withTmp(async root => {
    await mkdir(join(root, 'packs', 'good-pack'), { recursive: true })
    await mkdir(join(root, 'packs', 'bad dir!'), { recursive: true })
    await mkdir(join(root, 'packs', 'has-dots.id'), { recursive: true })
    await writeFile(join(root, 'packs', 'file.json'), '{}', 'utf8')
    const dirs = await discoverPackDirsIn(root, 'packs')
    assert.deepEqual(
      dirs.map((item) => item.label).sort(),
      ['packs/good-pack', 'packs/has-dots.id'],
    )
    assert.deepEqual(await discoverPackDirsIn(root, 'nope'), [])
  })
})

test('listDomainPacks returns the builtin pack first plus workspace packs', async () => {
  await withTmp(async root => {
    const packDir = await writeWorkspacePack(root, 'ws-pack')
    const ctx = fakeCtx([root])
    const list = await listDomainPacks(ctx)
    assert.equal(list.packs.length, 2)
    assert.equal(list.packs[0].id, ZHIJIAN_PACK_ID)
    assert.equal(list.packs[0].layer, 'builtin')
    const ws = list.packs[1]
    assert.equal(ws.id, 'ws-pack')
    assert.equal(ws.layer, 'workspace')
    assert.equal(ws.label, 'domain-packs/ws-pack')
    assert.equal(ws.ok, true)
    assert.equal(ws.counts.experts, 1)
    assert.equal(ws.root, await realpath(packDir))
  })
})

test('listDomainPacks reports a broken workspace pack with health and zero counts', async () => {
  await withTmp(async root => {
    await writeWorkspacePack(root, 'broken', { broken: true })
    const list = await listDomainPacks(fakeCtx([root]))
    const broken = list.packs.find((pack) => pack.id === 'broken')
    assert.ok(broken !== undefined)
    assert.equal(broken.ok, false)
    assert.ok(broken.errorCount >= 1)
    assert.equal(broken.counts.experts, 0)
  })
})

// --- Preview ------------------------------------------------------------------

test('previewDomainPack validates the builtin pack', async () => {
  const preview = await previewDomainPack(fakeCtx(), ZHIJIAN_PACK_ID)
  assert.ok(preview !== undefined)
  assert.equal(preview.ok, true)
  assert.equal(preview.pack?.id, ZHIJIAN_PACK_ID)
  assert.equal(preview.diagnostics.filter((d) => d.severity === 'error').length, 0)
  assert.ok(!Number.isNaN(Date.parse(preview.evaluatedAt)))
})

test('previewDomainPack returns undefined for unknown or unsafe ids', async () => {
  const ctx = fakeCtx()
  assert.equal(await previewDomainPack(ctx, 'no-such-pack'), undefined)
  assert.equal(await previewDomainPack(ctx, 'bad id!'), undefined)
  assert.equal(await previewDomainPack(ctx, '../escape'), undefined)
})

test('previewDomainPack of a broken workspace pack keeps diagnostics verbatim and drops pack', async () => {
  await withTmp(async root => {
    await writeWorkspacePack(root, 'broken', { broken: true })
    const preview = await previewDomainPack(fakeCtx([root]), 'broken')
    assert.ok(preview !== undefined)
    assert.equal(preview.ok, false)
    assert.equal(preview.pack, undefined)
    assert.ok(preview.diagnostics.length > 0)
    assert.ok(preview.diagnostics.every((d) => (
      typeof d.code === 'string' && typeof d.path === 'string'
      && typeof d.message === 'string'
      && ['error', 'warning', 'info'].includes(d.severity)
    )))
  })
})

test('previewDomainPack resolves a workspace pack by id across roots', async () => {
  await withTmp(async root => {
    const packDir = await writeWorkspacePack(root, 'ws-pack')
    const preview = await previewDomainPack(fakeCtx([root]), 'ws-pack')
    assert.ok(preview !== undefined)
    assert.equal(preview.ok, true)
    assert.equal(preview.pack?.root, await realpath(packDir))
  })
})
