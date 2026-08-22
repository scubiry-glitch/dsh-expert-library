/**
 * Input-boundary regression tests for the Expert Library.
 *
 * Runs against the built `lib/` output (plain JS, NodeNext), so `pnpm test`
 * requires `pnpm build` first — the test script chains both.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isSafeKnowledgeId } from '../lib/knowledge.js'
import { isSafeSkillId, resolveSkill, MAX_SKILL_BYTES } from '../lib/skills.js'
import { topicRouteFor, scenarioForTopic } from '../lib/zhijian/routing.js'
import { routeRequest } from '../lib/zhijian/tools.js'

/** Minimal stand-in plugin context: a logger that records nothing. */
const fakeCtx = { logger: { warn() {}, info() {} } }

test('isSafeKnowledgeId rejects traversal and accepts domain ids', () => {
  assert.equal(isSafeKnowledgeId('bk-004'), true)
  assert.equal(isSafeKnowledgeId('docs-coordinator'), true)
  assert.equal(isSafeKnowledgeId('宏观派1'), true)
  assert.equal(isSafeKnowledgeId('..'), false)
  assert.equal(isSafeKnowledgeId('../escape'), false)
  assert.equal(isSafeKnowledgeId('a/b'), false)
  assert.equal(isSafeKnowledgeId(''), false)
  assert.equal(isSafeKnowledgeId(' leadingspace'), false)
  assert.equal(isSafeKnowledgeId('x'.repeat(65)), false)
})

test('isSafeSkillId accepts local skill ids and rejects repo/path forms', () => {
  assert.equal(isSafeSkillId('video-shotcraft'), true)
  assert.equal(isSafeSkillId('gsap-skills'), true)
  assert.equal(isSafeSkillId('owner/repo'), false, 'repo form must be rejected — skills are local ids')
  assert.equal(isSafeSkillId('../escape'), false)
  assert.equal(isSafeSkillId('a/b'), false)
  assert.equal(isSafeSkillId(''), false)
  assert.equal(isSafeSkillId('x'.repeat(65)), false)
  assert.ok(MAX_SKILL_BYTES > 0 && MAX_SKILL_BYTES <= 4 * 1024 * 1024)
})

test('resolveSkill reads an installed local skill under knowledge/skills', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'skills-ok-'))
  try {
    const skillDir = join(workspace, 'knowledge', 'skills', 'good-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Good Skill\n本地方法论文本。', 'utf8')
    const resolved = await resolveSkill(fakeCtx, workspace, 'knowledge', 'good-skill')
    assert.ok(resolved.path !== undefined, 'installed skill resolves to a path')
    assert.ok(resolved.unavailable === undefined)
    assert.equal(resolved.id, 'good-skill')
    const text = await readFile(resolved.path, 'utf8')
    assert.match(text, /Good Skill/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('resolveSkill reports missing and invalid skills as locally-installable only', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'skills-missing-'))
  try {
    const missing = await resolveSkill(fakeCtx, workspace, 'knowledge', 'not-installed')
    assert.equal(missing.path, undefined)
    assert.ok(missing.unavailable !== undefined)
    assert.match(missing.unavailable, /本地/)

    const invalid = await resolveSkill(fakeCtx, workspace, 'knowledge', '../escape')
    assert.equal(invalid.path, undefined)
    assert.ok(invalid.unavailable !== undefined)
    assert.match(invalid.unavailable, /非法/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('resolveSkill rejects an oversized SKILL.md', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'skills-big-'))
  try {
    const skillDir = join(workspace, 'knowledge', 'skills', 'big-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), 'x'.repeat(MAX_SKILL_BYTES + 1), 'utf8')
    const resolved = await resolveSkill(fakeCtx, workspace, 'knowledge', 'big-skill')
    assert.equal(resolved.path, undefined)
    assert.match(resolved.unavailable, /KiB 体积限制/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('resolveSkill rejects a skill directory that symlinks outside the skills root', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'skills-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'skills-outside-'))
  try {
    await mkdir(join(outside, 'evil-skill'), { recursive: true })
    await writeFile(join(outside, 'evil-skill', 'SKILL.md'), '# Escaped\n外部内容', 'utf8')
    const skillsRoot = join(workspace, 'knowledge', 'skills')
    await mkdir(skillsRoot, { recursive: true })
    await symlink(join(outside, 'evil-skill'), join(skillsRoot, 'evil-skill'))
    const resolved = await resolveSkill(fakeCtx, workspace, 'knowledge', 'evil-skill')
    assert.equal(resolved.path, undefined, 'symlinked skill escaping the root must not resolve')
    assert.match(resolved.unavailable, /逃逸/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('skills resolver performs no network access (source-level guarantee)', async () => {
  const libPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'skills.js')
  const source = await readFile(libPath, 'utf8')
  assert.equal(/\bfetch\s*\(/.test(source), false, 'lib/skills.js must not call fetch')
  assert.equal(/githubusercontent/.test(source), false, 'lib/skills.js must not reference GitHub raw URLs')
  assert.equal(/\bhttps?:\/\//.test(source), false, 'lib/skills.js must not contain remote endpoints')
})

test('topicRouteFor falls back to the question text', () => {
  const byTopic = topicRouteFor('城市月度市场分析')
  assert.ok(byTopic !== undefined)
  const byQuestion = topicRouteFor('随便的话题前缀', '想请教城市月度市场分析方面的口径')
  assert.ok(byQuestion !== undefined)
  assert.ok(byQuestion.topic.startsWith('城市月度市场分析'))
  assert.equal(topicRouteFor('完全不相关'), undefined)
})

test('scenarioForTopic uses the question when the topic does not name one', () => {
  const scenario = scenarioForTopic('模糊主题', 'A', '涉及政策解读（新政策出台、政治局会议、定调变化）的问题')
  assert.ok(scenario !== undefined)
})

test('routeRequest output is anonymized: no real names in candidates', () => {
  const result = routeRequest('城市月度市场分析', '6月新房成交数据怎么看')
  assert.ok(result.candidates.length > 0 && result.candidates.length <= 5)
  for (const candidate of result.candidates) {
    assert.equal('name' in candidate, false, 'candidate must not expose the real name')
    assert.ok(candidate.id.startsWith('bk-'))
    assert.ok(candidate.bk.startsWith('BK-'))
    assert.ok(candidate.initials.length > 0)
  }
})
