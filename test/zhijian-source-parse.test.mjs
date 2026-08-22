/**
 * Hardened 智见点评 source parser tests.
 *
 * Verifies the shared parser (`scripts/zhijian-source.mjs`) used by both
 * build scripts:
 * - the domain pack's embedded source parses cleanly to the exact 32-expert
 *   baseline and regenerates `experts.generated.ts` byte-identically;
 * - every roster/profile inconsistency is FATAL (structured errors, never a
 *   silent skip): roster row without a profile, profile without a roster row,
 *   unparseable profile, real-name mismatch, persona-name mismatch, duplicate
 *   roster row;
 * - both accepted source layouts (zip tree, pack source) parse identically;
 * - parsing is deterministic (two runs produce equal metas).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseZhijianSource, parseRoster, emitExpertsTs } from '../scripts/zhijian-source.mjs'

/** The domain pack's embedded source (docs/ + raw-profiles/ + library/). */
const PACK_SOURCE = new URL('../domain-packs/zhijian-realestate/source', import.meta.url).pathname
/** The committed generated TS (regeneration target). */
const GENERATED_TS = new URL('../src/zhijian/data/experts.generated.ts', import.meta.url).pathname

/** Minimal valid roster for fixtures (2 rows, one field group). */
const MINI_ROSTER = `# 专家总表（fixture）
### 1. 测试领域（2 位）
| BK-900 | 测试人甲 | 测试派 X 教授 | 测试派 | — | 数据/研判 | 一句话摘要甲 |
| BK-901 | 测试人乙 | 风险派 X 博士 | 风险派 | 行业研究 | 理论 | 一句话摘要乙 |
`

/** Minimal valid Profile JSON matching the roster row for `bk`. */
function miniProfile(bk, personaName, overrides = {}) {
  return {
    expert_id: bk,
    name: personaName,
    persona: { style: '结论先行' },
    method: { frameworks: ['框架一'], analysis_steps: ['步骤一'] },
    signature_phrases: ['金句'],
    anti_patterns: ['禁区'],
    initials: 'X',
    ...overrides,
  }
}

/** Write a pack-layout fixture: <root>/docs/专家总表.md + <root>/raw-profiles/*.json. */
async function writePackFixture(root, { roster = MINI_ROSTER, profiles = [] }) {
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'raw-profiles'), { recursive: true })
  await writeFile(join(root, 'docs', '专家总表.md'), roster, 'utf8')
  for (const [fileName, json] of profiles) {
    await writeFile(join(root, 'raw-profiles', fileName), `${JSON.stringify(json)}\n`, 'utf8')
  }
}

/** Write a minimal zip-layout fixture: <root>/智见点评/{专家总表.md, 专家材料/<name>/…}. */
async function writeZipFixture(root, { roster = MINI_ROSTER, profiles = [] }) {
  const zj = join(root, '智见点评')
  await mkdir(join(zj, '专家材料'), { recursive: true })
  await writeFile(join(zj, '专家总表.md'), roster, 'utf8')
  for (const [realName, fileName, json] of profiles) {
    await mkdir(join(zj, '专家材料', realName), { recursive: true })
    await writeFile(join(zj, '专家材料', realName, fileName), `${JSON.stringify(json)}\n`, 'utf8')
  }
}

const EXPECTED_FIELD_COUNTS = { '宏观经济': 9, '政策制度': 8, '行业研究': 8, '城市发展': 3, '居住服务': 4 }

// ── 1. the pack's embedded source ───────────────────────────────────────────

test('pack source parses clean: 32 experts, ids bk-002..bk-033, field counts, deceased bk-022', async () => {
  const parsed = await parseZhijianSource(PACK_SOURCE)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors))
  assert.equal(parsed.layout, 'pack')
  assert.equal(parsed.experts.length, 32)
  const ids = parsed.experts.map(e => e.id)
  assert.deepEqual(ids, Array.from({ length: 32 }, (_, i) => `bk-${String(i + 2).padStart(3, '0')}`))
  assert.ok(!ids.includes('bk-034'), 'BK-034 must not be silently merged into the 1.0.0 baseline')
  const fieldCounts = {}
  for (const e of parsed.experts) fieldCounts[e.field] = (fieldCounts[e.field] ?? 0) + 1
  assert.deepEqual(fieldCounts, EXPECTED_FIELD_COUNTS)
  assert.equal(parsed.experts.find(e => e.bk === 'BK-022').deceased, true)
  assert.equal(parsed.experts.filter(e => e.deceased === true).length, 1)
})

test('embedded source regenerates experts.generated.ts byte-identically', async () => {
  const parsed = await parseZhijianSource(PACK_SOURCE)
  assert.equal(parsed.ok, true)
  const regenerated = emitExpertsTs(parsed.experts)
  const { readFile } = await import('node:fs/promises')
  const committed = await readFile(GENERATED_TS, 'utf8')
  assert.equal(regenerated, committed, 'regeneration from the embedded source must be byte-identical to the committed TS')
})

// ── 2. determinism ──────────────────────────────────────────────────────────

test('parsing is deterministic (two runs deep-equal)', async () => {
  const [a, b] = await Promise.all([parseZhijianSource(PACK_SOURCE), parseZhijianSource(PACK_SOURCE)])
  assert.deepEqual(a.experts, b.experts)
  assert.deepEqual(a.profiles, b.profiles)
})

// ── 3. fatal mismatches ─────────────────────────────────────────────────────

test('fatal: roster row without a Profile JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zj-src-'))
  try {
    await writePackFixture(root, {
      profiles: [['测试人甲_专家Profile_BK-900.json', miniProfile('BK-900', '测试派 X 教授')]],
    })
    const parsed = await parseZhijianSource(root)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.errors.some(e => e.code === 'roster-without-profile'), JSON.stringify(parsed.errors))
    assert.ok(parsed.errors.some(e => e.message.includes('BK-901')), JSON.stringify(parsed.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fatal: Profile JSON without a roster row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zj-src-'))
  try {
    await writePackFixture(root, {
      profiles: [
        ['测试人甲_专家Profile_BK-900.json', miniProfile('BK-900', '测试派 X 教授')],
        ['测试人丙_专家Profile_BK-902.json', miniProfile('BK-902', '游离派 X 研究员')],
      ],
    })
    const parsed = await parseZhijianSource(root)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.errors.some(e => e.code === 'profile-without-roster'), JSON.stringify(parsed.errors))
    assert.ok(parsed.errors.some(e => e.message.includes('BK-902')), JSON.stringify(parsed.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fatal: unparseable Profile JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zj-src-'))
  try {
    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(join(root, 'raw-profiles'), { recursive: true })
    await writeFile(join(root, 'docs', '专家总表.md'), MINI_ROSTER, 'utf8')
    await writeFile(join(root, 'raw-profiles', '测试人甲_专家Profile_BK-900.json'), '{ not json', 'utf8')
    const parsed = await parseZhijianSource(root)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.errors.some(e => e.code === 'profile-parse'), JSON.stringify(parsed.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fatal: real-name mismatch between file name and roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zj-src-'))
  try {
    await writePackFixture(root, {
      profiles: [['错名_专家Profile_BK-900.json', miniProfile('BK-900', '测试派 X 教授')]],
    })
    const parsed = await parseZhijianSource(root)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.errors.some(e => e.code === 'name-mismatch'), JSON.stringify(parsed.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fatal: persona-name mismatch between Profile and roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zj-src-'))
  try {
    await writePackFixture(root, {
      profiles: [['测试人甲_专家Profile_BK-900.json', miniProfile('BK-900', '另一派 X 教授')]],
    })
    const parsed = await parseZhijianSource(root)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.errors.some(e => e.code === 'persona-name-mismatch'), JSON.stringify(parsed.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fatal: duplicate roster row', async () => {
  const roster = MINI_ROSTER + '| BK-900 | 测试人丁 | 重复派 X 教授 | 重复派 | — | 数据 | 重复 |\n'
  const root = await mkdtemp(join(tmpdir(), 'zj-src-'))
  try {
    await writePackFixture(root, {
      roster,
      profiles: [
        ['测试人甲_专家Profile_BK-900.json', miniProfile('BK-900', '测试派 X 教授')],
        ['测试人乙_专家Profile_BK-901.json', miniProfile('BK-901', '风险派 X 博士')],
      ],
    })
    const parsed = await parseZhijianSource(root)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.errors.some(e => e.code === 'duplicate-roster-row'), JSON.stringify(parsed.errors))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 4. zip layout ───────────────────────────────────────────────────────────

test('zip layout parses clean and equals the pack layout result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zj-zip-'))
  try {
    await writeZipFixture(root, {
      profiles: [
        ['测试人甲', '测试人甲_专家Profile_BK-900.json', miniProfile('BK-900', '测试派 X 教授')],
        ['测试人乙', '测试人乙_专家Profile_BK-901.json', miniProfile('BK-901', '风险派 X 博士')],
      ],
    })
    const parsed = await parseZhijianSource(root)
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors))
    assert.equal(parsed.layout, 'zip')
    assert.deepEqual(parsed.experts.map(e => e.id), ['bk-900', 'bk-901'])
    // metas carry the same derived fields as the pack layout
    assert.equal(parsed.experts[0].name, '测试人甲')
    assert.equal(parsed.experts[0].personaName, '测试派 X 教授')
    assert.equal(parsed.experts[0].field, '测试领域')
    assert.equal(parsed.experts[0].stance, '测试派')
    assert.deepEqual(parsed.experts[0].tags, ['数据', '研判'])
    assert.equal(parsed.experts[0].initials, 'X')
    assert.deepEqual(parsed.experts[1].secondaryField, '行业研究')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parseRoster rejects a duplicated BK id (table-level guard)', () => {
  assert.throws(
    () => parseRoster(MINI_ROSTER + '| BK-900 | x | y | z | — | a | b |\n'),
    error => error.code === 'duplicate-roster-row',
  )
})
