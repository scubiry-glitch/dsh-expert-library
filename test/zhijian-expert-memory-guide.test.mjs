/**
 * `zhijian.expert-memory` honest-minimal-serving tests (audit gap "declared
 * but not served"): the persona guide section built pack-first from the
 * on-disk zhijian pack via the real pack loader.
 *
 * Covers: zhijian teams get the orientation section (pointing at the entity
 * records); generic teams / scenario-less teams get nothing; a missing pack
 * or missing manifest file degrades to a warning note instead of failing;
 * the section flows into the composed zhijian persona. All hermetic (temp-dir
 * pack fixtures, no network). Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expertMemoryGuideSection, ZHIJIAN_EXPERT_MEMORY_KB, ZHIJIAN_PACK_DIR } from '../lib/zhijian/expert-memory.js'
import { zhijianExpertPersona } from '../lib/zhijian/persona.js'
import { ZHIJIAN_EXPERTS } from '../lib/zhijian/data/experts.generated.js'

/* ---------------------------------------------------------------------------
 * Minimal valid zhijian pack fixture (directory layout, loadPackFromDir-ready)
 * ------------------------------------------------------------------------- */

const PACKS_DIR = 'domain-packs'

function scenarioEntity(overrides = {}) {
  return {
    id: 'zhijian-monthly',
    version: '1.1.0',
    schemaVersion: 2,
    domain: 'realestate',
    intents: ['monthly-review'],
    requiredCapabilities: [{ capability: 'zhijian.review', minProficiency: 1, cardinality: 1 }],
    routingPolicy: { candidateHints: ['bk-024'] },
    teamTemplate: 'zhijian.team.A',
    outputTemplate: 'zhijian.output.A',
    qualityPolicy: 'zhijian.quality',
    knowledgePolicy: { required: ['zhijian-expert-memory'] },
    toolPolicy: { allowed: [] },
    ...overrides,
  }
}

const teamTemplate = {
  id: 'zhijian.team.A',
  version: '1.1.0',
  schemaVersion: 2,
  slots: [{ id: 'role.reviewer', capabilities: ['zhijian.review'], cardinality: { min: 1, max: 1 } }],
  tasks: [{ id: 't1', role: 'role.reviewer', dependsOn: [], inputs: [], allowedCapabilities: [], outputSchema: 'zhijian.output.A', retryPolicy: 'never' }],
  gates: [],
  deliverables: [],
}

const outputTemplate = {
  id: 'zhijian.output.A',
  version: '1.1.0',
  schemaVersion: 2,
  media: ['markdown'],
  sections: [],
  renderModes: { discussion: { anonymize: true } },
}

const qualityPolicy = { id: 'zhijian.quality', version: '1.1.0', schemaVersion: 2, gates: [] }

const knowledgeProvider = {
  id: 'zhijian-expert-memory',
  version: '1.1.0',
  schemaVersion: 2,
  kind: 'database',
  capabilities: ['search', 'read', 'cite', 'history'],
  freshness: 'monthly',
  scopes: ['experts'],
  domainKnowledgeIds: ['zhijian.expert-memory'],
}

const memoryManifest = {
  id: 'zhijian.expert-memory',
  version: '1.1.0',
  schemaVersion: 2,
  domain: 'realestate.research',
  boundary: '测试边界：33 位房地产专家 Profile 基线（身份/领域/立场/风格/心智模型/禁区）。',
  ontology: {
    entities: [
      { id: 'expert', description: '领域专家' },
      { id: 'field', description: '五大主领域' },
      { id: 'stance', description: '专家立场标签' },
    ],
    relations: [],
  },
  collections: [{ id: 'experts', root: 'experts', format: 'json', description: '每专家一个 Profile 记录' }],
  snapshot: { id: 'snap-test', takenAt: '2026-08-21T00:00:00Z', digest: 'deadbeef', recordCount: 33 },
  retrievalProfiles: [{ id: 'by-id', method: 'keyword' }],
  policies: { citation: 'required', freshness: 'monthly', access: 'readonly' },
}

/** Write the minimal valid pack under `<tmp>/domain-packs/zhijian-realestate/`. */
async function writePackFixture(workspace, options = {}) {
  const root = join(workspace, PACKS_DIR, ZHIJIAN_PACK_DIR)
  const write = async (rel, value) => {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    if (options.corruptPackJson === true && rel === 'pack.json') {
      await writeFile(abs, '{ not valid json')
      return
    }
    await writeFile(abs, `${JSON.stringify(value, null, 2)}\n`)
  }
  await write('pack.json', { id: ZHIJIAN_PACK_DIR, version: '1.1.0', schemaVersion: 2, name: 'fixture' })
  await write('scenarios/zhijian-monthly.json', options.scenario ?? scenarioEntity())
  await write('team-templates/zhijian.team.A.json', teamTemplate)
  await write('output-templates/zhijian.output.A.json', outputTemplate)
  await write('quality-policies/zhijian.quality.json', qualityPolicy)
  await write('knowledge-providers/zhijian-expert-memory.json', knowledgeProvider)
  if (options.withoutManifest !== true) {
    await write('domain-knowledge/zhijian.expert-memory.json', memoryManifest)
  }
}

function guide(workspace, scenarioId) {
  return expertMemoryGuideSection({ workspace, packsDir: PACKS_DIR, scenarioId })
}

/* ---------------------------------------------------------------------------
 * Section presence
 * ------------------------------------------------------------------------- */

test('zhijian team (scenario requires zhijian-expert-memory) gets the orientation section', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    await writePackFixture(workspace)
    const section = await guide(workspace, 'zhijian-monthly')
    assert.equal(typeof section, 'string')
    assert.ok(section.length > 0, 'section must be non-empty')
    assert.match(section, new RegExp(ZHIJIAN_EXPERT_MEMORY_KB))
    assert.match(section, /experts\/bk-\*\.json/, 'points at the entity records')
    assert.match(section, /domain-knowledge\/zhijian\.expert-memory\.json/, 'names the manifest file')
    assert.match(section, /测试边界/, 'carries the manifest boundary')
    assert.match(section, /用法：/, 'explains how to use it')
    const lines = section.split('\n')
    assert.ok(lines.length >= 3 && lines.length <= 6, `orientation must be 3-6 lines, got ${lines.length}`)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('generic team (scenario not in the zhijian pack) gets no section', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    await writePackFixture(workspace)
    assert.equal(await guide(workspace, 'collab.cross-debate'), '')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('scenario-less team gets no section', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    await writePackFixture(workspace)
    assert.equal(await guide(workspace, undefined), '')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('a zhijian scenario whose knowledge policy does not require the memory base gets no section', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    await writePackFixture(workspace, { scenario: scenarioEntity({ knowledgePolicy: { required: ['local-knowledge'] } }) })
    assert.equal(await guide(workspace, 'zhijian-monthly'), '')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * Degradation (never fail team creation)
 * ------------------------------------------------------------------------- */

test('missing pack directory degrades to a warning note for a zhijian scenario', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    // No pack written at all.
    const section = await guide(workspace, 'zhijian-monthly')
    assert.equal(typeof section, 'string')
    assert.ok(section.length > 0, 'degraded guide must still be non-empty')
    assert.match(section, /警告/, 'warns instead of failing')
    assert.match(section, /不可用/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('missing manifest file degrades to a warning note for a zhijian scenario', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    await writePackFixture(workspace, { withoutManifest: true })
    const section = await guide(workspace, 'zhijian-monthly')
    assert.ok(section.length > 0)
    assert.match(section, /警告/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('corrupt pack.json never throws and degrades for a zhijian scenario', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    await writePackFixture(workspace, { corruptPackJson: true })
    const section = await guide(workspace, 'zhijian-monthly')
    assert.equal(typeof section, 'string')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * Persona composition
 * ------------------------------------------------------------------------- */

test('the section flows into the composed zhijian expert persona', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'expert-memory-guide-'))
  try {
    await writePackFixture(workspace)
    const section = await guide(workspace, 'zhijian-monthly')
    const meta = ZHIJIAN_EXPERTS.find(item => item.id === 'bk-024')
    assert.ok(meta !== undefined)
    const team = {
      id: 'team1',
      name: '点评团队',
      captainSessionId: 'sess-c',
      createdAt: 1,
      members: [],
      tasks: [],
      taskSeq: 0,
    }
    const member = { id: 'm1', name: '丁祖昱', joinedAt: 1, status: 'idle' }
    const persona = zhijianExpertPersona(team, member, 'expert-teams', meta, 'A', section)
    assert.match(persona, new RegExp(ZHIJIAN_EXPERT_MEMORY_KB))
    assert.match(persona, /experts\/bk-\*\.json/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
