/**
 * Error-path suggestion loop tests — when a skill reference FAILS to resolve,
 * the unavailable hint must list the currently available local skill ids
 * (workspace `<knowledgeDir>/skills/` + the plugin's bundled knowledge/skills,
 * deduped — the same union the `/skills` route reports), so the correction
 * text always offers concrete alternatives. Covers `resolveSkill` directly and
 * the `skillDescriptionBlock` propagation used by the ppt `skill_id` path and
 * the scenario skill binding. Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSkill, skillDescriptionBlock, availableSkillIdsText } from '../lib/skills.js'

/** No-op logger stub (resolveSkill only logs). */
const ctx = { logger: { warn: () => {}, info: () => {} } }

/** Temp workspace with `<workspace>/knowledge/skills/<id>/SKILL.md` per entry. */
function makeWorkspace(skills) {
  const workspace = mkdtempSync(join(tmpdir(), 'skills-resolve-'))
  for (const id of Object.keys(skills)) {
    const dir = join(workspace, 'knowledge', 'skills', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skills[id])
  }
  return workspace
}

function cleanup(...workspaces) {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true })
}

test('(a) resolveSkill unavailable lists the currently available workspace skill ids', async () => {
  const workspace = makeWorkspace({ alpha: '# alpha', beta: '# beta' })
  try {
    const resolved = await resolveSkill(ctx, workspace, 'knowledge', 'foo')
    assert.equal(resolved.path, undefined)
    assert.ok(resolved.unavailable?.includes('本地未安装 skill「foo」'), 'main missing-skill hint preserved')
    assert.ok(resolved.unavailable?.includes('当前可用：alpha, beta'), `must suggest the live ids, got: ${resolved.unavailable}`)
  } finally {
    cleanup(workspace)
  }
})

test('(b) expert_teams_ppt skill_id path: the embedded block carries the available ids', async () => {
  // The ppt tool builds `skillBlock = \n\n${skillDescriptionBlock(resolved)}`
  // (no purpose) — the unavailable hint must surface the live list in that
  // exact block shape.
  const workspace = makeWorkspace({ alpha: '# alpha', beta: '# beta' })
  try {
    const resolved = await resolveSkill(ctx, workspace, 'knowledge', 'ghost-skill')
    const block = skillDescriptionBlock(resolved)
    assert.ok(block.startsWith('外部 skill：'), 'the ppt path appends this exact block shape')
    assert.ok(block.includes('ghost-skill'), 'block names the failed skill')
    assert.ok(block.includes('当前可用：alpha, beta'), `ppt skill_id hint must suggest the live ids, got: ${block}`)
  } finally {
    cleanup(workspace)
  }
})

test('(c) scenario skill-binding path: the embedded block (with purpose) carries the available ids', async () => {
  // The scenario apply path builds `skillBlock = \n\n${skillDescriptionBlock(
  // resolved, scenario.skill.purpose)}` — same propagation, purpose line on.
  const workspace = makeWorkspace({ alpha: '# alpha', beta: '# beta' })
  try {
    const resolved = await resolveSkill(ctx, workspace, 'knowledge', 'video-shotcraft', 'video-shotcraft')
    const block = skillDescriptionBlock(resolved, '可选增强：产品视频')
    assert.ok(block.includes('（用途：可选增强：产品视频）'), 'scenario path passes the skill purpose')
    assert.ok(block.includes('当前可用：alpha, beta'), `scenario skill hint must suggest the live ids, got: ${block}`)
  } finally {
    cleanup(workspace)
  }
})

test('resolveSkill unavailable also lists the plugin bundled skills (union)', async () => {
  // Empty workspace skills dir — the union still surfaces the bundled set.
  const workspace = makeWorkspace({})
  try {
    const resolved = await resolveSkill(ctx, workspace, 'knowledge', 'nope')
    assert.ok(resolved.unavailable?.includes('当前可用：'), `missing-skill hint must carry a 当前可用 line, got: ${resolved.unavailable}`)
    assert.ok(resolved.unavailable?.includes('finesse-ui'), 'bundled finesse-ui appears in the suggestion list')
    assert.ok(resolved.unavailable?.includes('video-shotcraft'), 'bundled video-shotcraft appears in the suggestion list')
  } finally {
    cleanup(workspace)
  }
})

test('resolveSkill suggestion list dedupes the workspace set against the bundled set', async () => {
  // The workspace installs its own copy of finesse-ui: the id must appear once.
  const workspace = makeWorkspace({ 'finesse-ui': '# local copy' })
  try {
    const resolved = await resolveSkill(ctx, workspace, 'knowledge', 'missing')
    const line = resolved.unavailable ?? ''
    const ids = line.slice(line.indexOf('当前可用：') + '当前可用：'.length)
    assert.ok(!ids.includes('finesse-ui, finesse-ui'), `no duplicate id in the list: ${line}`)
  } finally {
    cleanup(workspace)
  }
})

test('resolveSkill invalid-id failure also carries the available list', async () => {
  const workspace = makeWorkspace({ alpha: '# alpha' })
  try {
    const resolved = await resolveSkill(ctx, workspace, 'knowledge', 'bad id')
    assert.ok(resolved.unavailable?.includes('非法 skill id'), 'invalid-id hint preserved')
    assert.ok(resolved.unavailable?.includes('当前可用：alpha'), `invalid-id hint must suggest the live ids, got: ${resolved.unavailable}`)
  } finally {
    cleanup(workspace)
  }
})

test('resolveSkill success stays clean: no available-list suffix, path set', async () => {
  const workspace = makeWorkspace({ alpha: '# alpha' })
  try {
    const resolved = await resolveSkill(ctx, workspace, 'knowledge', 'alpha')
    assert.ok(resolved.path !== undefined)
    assert.equal(resolved.unavailable, undefined)
    assert.equal(resolved.name, 'alpha')
  } finally {
    cleanup(workspace)
  }
})

test('empty case: no available ids formats as 「当前可用：（无）」', () => {
  assert.equal(availableSkillIdsText([]), '\n当前可用：（无）')
  assert.equal(availableSkillIdsText(['alpha', 'beta']), '\n当前可用：alpha, beta。')
  // The suffix is appended to the unavailable hint by resolveSkill — the
  // formatter output is the exact tail of every failure message.
  const resolved = { id: 'foo', name: 'foo', unavailable: '本地未安装 skill「foo」。' + availableSkillIdsText([]) }
  assert.equal(resolved.unavailable, '本地未安装 skill「foo」。\n当前可用：（无）')
})
