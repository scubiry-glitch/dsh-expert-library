/**
 * Skill discovery tests — the read-only scan behind
 * `GET /plugins/dsh-expert-library/skills` (src/skills-discovery.ts):
 *
 * - frontmatter `name:` extraction (plain / quoted / missing / no block);
 * - one-root scanning (sizeBytes, path, hasReferences, safe-id filtering);
 * - multi-workspace union with dedupe (first hit per id wins);
 * - empty state (no roots / empty skills dir → zero entries).
 * Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  builtinSkillIdsSync,
  collectSkillEntries,
  pluginKnowledgeRoot,
  scanSkillsRoot,
  skillDiscoveryPromptSection,
  skillNameFromFrontmatter,
  skillsInventoryLine,
} from '../lib/skills-discovery.js'

/** Temp-dir helper: creates `<root>/skills/<id>/SKILL.md` and returns the root. */
function makeSkillsRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'skills-discovery-'))
  const skills = join(root, 'skills')
  mkdirSync(skills, { recursive: true })
  for (const [id, { skillMd, extra = [], asFile = false }] of Object.entries(files)) {
    if (asFile) {
      // A plain file at the skills root (not a skill folder).
      if (skillMd !== undefined) writeFileSync(join(skills, id), skillMd)
      continue
    }
    const dir = join(skills, id)
    mkdirSync(dir, { recursive: true })
    if (skillMd !== undefined) writeFileSync(join(dir, 'SKILL.md'), skillMd)
    for (const extraFile of extra) {
      if (extraFile.endsWith('/')) mkdirSync(join(dir, extraFile), { recursive: true })
      else writeFileSync(join(dir, extraFile), 'x')
    }
  }
  return root
}

function cleanup(...roots) {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}

// ── 1. Frontmatter name extraction ───────────────────────────────────────────

test('skillNameFromFrontmatter: plain, quoted, missing, and no-frontmatter cases', () => {
  assert.equal(skillNameFromFrontmatter('---\nname: my-skill\ndescription: d\n---\n# body'), 'my-skill')
  assert.equal(skillNameFromFrontmatter('---\nname: "quoted skill"\n---\n'), 'quoted skill')
  assert.equal(skillNameFromFrontmatter("---\nname: 'single quoted'\n---\n"), 'single quoted')
  // A frontmatter block without a name line → undefined (fall back to id).
  assert.equal(skillNameFromFrontmatter('---\ndescription: no name here\n---\nbody'), undefined)
  // No frontmatter block at all → undefined.
  assert.equal(skillNameFromFrontmatter('# plain markdown\nbody'), undefined)
  // A `name:` line after the closing fence is NOT frontmatter → undefined.
  assert.equal(skillNameFromFrontmatter('---\ndescription: d\n---\nname: not-frontmatter\n'), undefined)
  // Empty value → undefined.
  assert.equal(skillNameFromFrontmatter('---\nname:\n---\n'), undefined)
  // Oversized frontmatter is capped by the peek window (never explodes).
  const huge = '---\nname: ok\n' + 'x'.repeat(20_000) + '\n---\n'
  assert.equal(skillNameFromFrontmatter(huge), 'ok')
})

// ── 2. Single-root scan ──────────────────────────────────────────────────────

test('scanSkillsRoot: rows carry id/name/path/sizeBytes/hasReferences; unsafe ids are filtered', async () => {
  const root = makeSkillsRoot({
    'finesse-ui': { skillMd: '---\nname: finesse-ui\n---\n# Finesse', extra: ['references/', 'examples/'] },
    'video-shotcraft': { skillMd: '---\nname: "video-shotcraft"\n---\n# Video', extra: ['template/'] },
    'bare-skill': { skillMd: 'no frontmatter at all\n# Body' },
    'no-skill-md': { extra: ['references/'] },
    'bad id': { skillMd: '# unsafe — spaces' },
    '..': { skillMd: '# traversal' },
    'plain-file.txt': { skillMd: 'not a skill folder — a bare file', asFile: true },
  })
  try {
    const entries = await scanSkillsRoot(join(root, 'skills'))
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    // Unsafe entries (spaces, `..`, files at the skills root) never appear.
    assert.deepEqual([...byId.keys()].sort(), ['bare-skill', 'finesse-ui', 'no-skill-md', 'video-shotcraft'])

    const finesse = byId.get('finesse-ui')
    assert.equal(finesse?.name, 'finesse-ui')
    assert.ok(finesse?.path.endsWith(join('skills', 'finesse-ui', 'SKILL.md')))
    assert.ok(finesse?.sizeBytes > 0, 'SKILL.md size is recorded')
    assert.equal(finesse?.hasReferences, true, 'references/ + examples/ count as references')

    const quoted = byId.get('video-shotcraft')
    assert.equal(quoted?.name, 'video-shotcraft', 'quoted frontmatter name is unquoted')

    const bare = byId.get('bare-skill')
    assert.equal(bare?.name, 'bare-skill', 'no frontmatter → name falls back to the id')
    assert.ok(bare?.sizeBytes > 0)

    const noMd = byId.get('no-skill-md')
    assert.equal(noMd?.sizeBytes, 0, 'missing SKILL.md → zero size')
    assert.equal(noMd?.hasReferences, true, 'folder content still counts as references')
    assert.ok(noMd?.path.endsWith('SKILL.md'), 'path still points at the expected SKILL.md location')
  } finally {
    cleanup(root)
  }
})

test('scanSkillsRoot: a missing/unreadable skills root yields zero entries', async () => {
  const missing = await scanSkillsRoot(join(tmpdir(), 'no-such-skills-root-xyz'))
  assert.deepEqual(missing, [])
  const root = makeSkillsRoot({})
  try {
    assert.deepEqual(await scanSkillsRoot(join(root, 'skills')), [])
  } finally {
    cleanup(root)
  }
})

// ── 3. Multi-workspace union + dedupe ────────────────────────────────────────

test('collectSkillEntries: first hit per id wins across roots, entries id-sorted', async () => {
  const a = makeSkillsRoot({
    'shared-skill': { skillMd: '---\nname: shared-v1\n---\n# A copy' },
    'only-a': { skillMd: '---\nname: only-a\n---\n# A' },
  })
  const b = makeSkillsRoot({
    'shared-skill': { skillMd: '---\nname: shared-v2\n---\n# B copy (must lose)' },
    'only-b': { skillMd: '---\nname: only-b\n---\n# B' },
  })
  try {
    const entries = await collectSkillEntries([join(a, 'skills'), join(b, 'skills')])
    assert.deepEqual(entries.map(entry => entry.id), ['only-a', 'only-b', 'shared-skill'])
    const shared = entries.find(entry => entry.id === 'shared-skill')
    assert.equal(shared?.name, 'shared-v1', 'the first root shadows the second')
    assert.ok(shared?.path.startsWith(a), 'the winning entry comes from the first root')
  } finally {
    cleanup(a, b)
  }
})

test('collectSkillEntries: empty state — no roots or empty roots give []', async () => {
  assert.deepEqual(await collectSkillEntries([]), [])
  const root = makeSkillsRoot({})
  try {
    assert.deepEqual(await collectSkillEntries([join(root, 'skills'), join(root, 'skills')]), [])
  } finally {
    cleanup(root)
  }
})

// ── 4. Plugin knowledge root ─────────────────────────────────────────────────

test('pluginKnowledgeRoot: resolves the bundled knowledge/ dir when present', async () => {
  const root = await pluginKnowledgeRoot()
  if (root === undefined) return // published layout without knowledge/ — skip
  const entries = await scanSkillsRoot(join(root, 'skills'))
  const ids = new Set(entries.map(entry => entry.id))
  assert.ok(ids.has('finesse-ui'), 'bundled knowledge ships the finesse-ui skill')
  assert.ok(ids.has('video-shotcraft'), 'bundled knowledge ships the video-shotcraft skill')
  assert.ok(ids.has('gsap-core'), 'bundled knowledge ships the gsap skills')
})

// ── 5. Mount-time inventory + prompt section ─────────────────────────────────

test('builtinSkillIdsSync: mount-time bundled inventory, safe-id filtered, sorted', () => {
  const ids = builtinSkillIdsSync()
  assert.ok(ids.includes('finesse-ui'), 'bundled finesse-ui is inventoryable at mount')
  assert.ok(ids.includes('video-shotcraft'), 'bundled video-shotcraft is inventoryable at mount')
  assert.ok(ids.some(id => id.startsWith('gsap-')), 'bundled gsap-* skills are inventoryable at mount')
  assert.deepEqual(ids, [...ids].sort(), 'inventory is id-sorted')
  for (const id of ids) {
    assert.match(id, /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u, 'every inventoried id is a safe skill id')
  }
})

test('skillDiscoveryPromptSection: names the convention + the channel + the inventory line', () => {
  const inventoryLine = '插件自带 skills（挂载时）：finesse-ui, video-shotcraft'
  const withIds = skillDiscoveryPromptSection(inventoryLine)
  assert.ok(withIds.includes('<workspace>/<knowledgeDir>/skills/<id>/SKILL.md'), 'names the knowledge/skills convention')
  assert.ok(withIds.includes('GET /plugins/dsh-expert-library/skills'), 'names the inventory channel explicitly')
  assert.ok(withIds.includes(inventoryLine), 'folds in the given inventory line')
  assert.ok(withIds.includes('① the session skill catalog'), 'keeps the check order')
  assert.ok(withIds.includes('④ the marketplace'), 'keeps the full check order')
  assert.ok(withIds.includes('filesystem search FIRST'), 'keeps the filesystem-first rule')
})

test('skillDiscoveryPromptSection: without a resolvable inventory the mechanism is still named', () => {
  const fallback = skillDiscoveryPromptSection('插件自带 skills 目录在挂载时不可解析——用上面的路由在运行时查询实际清单')
  assert.ok(fallback.includes('GET /plugins/dsh-expert-library/skills'), 'the channel is named even without an inventory')
  assert.ok(fallback.includes('挂载时不可解析'), 'explicitly states the inventory was not resolvable at mount')
  assert.ok(fallback.includes('<workspace>/<knowledgeDir>/skills/<id>/SKILL.md'), 'the convention is named')
})

test('skillsInventoryLine: renders id lists and the empty case', () => {
  assert.equal(skillsInventoryLine(['a', 'b'], '当前已安装 skills'), '当前已安装 skills：a, b')
  assert.equal(skillsInventoryLine([], '当前已安装 skills'), '当前已安装 skills：无（本地 skills 目录未发现任何 skill）')
})
