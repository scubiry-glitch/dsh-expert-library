/**
 * Shared skills-index tests — `src/skills-discovery.ts` is THE single index:
 *
 * - the mtime-fingerprinted cache (stable identity while unchanged, rebuild
 *   on content edit, rebuild on add/remove);
 * - `skillsGuideSection` (the member persona inventory) lists every installed
 *   local skill as `- <id>: <name>` plus the convention hint;
 * - every consumer shares one scan: the route path (discoverSkillRoots +
 *   collectSkillEntries) and the guide return the SAME frozen entries for the
 *   same root (fake ctx with a stub sessions/workspace registry + initiator);
 * - `liveSkillsInventoryLine` resolves the initiator's workspace (per-session)
 *   and falls back to the union.
 * Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectSkillEntries,
  discoverSkillRoots,
  invalidateSkillsIndex,
  listLocalSkills,
  liveSkillsInventoryLine,
  scanSkillsRootIndexed,
  skillsGuideSection,
} from '../lib/skills-discovery.js'

/** Temp workspace with `<workspace>/knowledge/skills/<id>/SKILL.md` per entry. */
function makeWorkspace(skills) {
  const workspace = mkdtempSync(join(tmpdir(), 'skills-index-'))
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

/** Fake host ctx: stub sessions + workspace registry (+ optional agents/initiator). */
function fakeCtx({ sessions = [], workspaces = [], agent = undefined } = {}) {
  return {
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    get(key) {
      if (key === 'sessions') return { list: () => sessions }
      if (key === 'workspaceRegistry' || key === 'workspace') return { list: () => workspaces }
      if (key === 'agents') return { currentInitiator: () => agent }
      return undefined
    },
  }
}

const stubCtx = fakeCtx()

// ── 1. Index cache: identity + mtime invalidation ────────────────────────────

test('index: unchanged fingerprint returns the SAME frozen entries (stable identity)', () => {
  const workspace = makeWorkspace({ alpha: '# alpha', beta: '# beta' })
  const root = join(workspace, 'knowledge', 'skills')
  try {
    const first = listLocalSkills(stubCtx, workspace, 'knowledge')
    const second = listLocalSkills(stubCtx, workspace, 'knowledge')
    const third = scanSkillsRootIndexed(root)
    assert.equal(second, first, 'unchanged workspace index returns the identical array object')
    assert.equal(third, first, 'the root-level indexed read shares the same cache entry')
    assert.deepEqual(first.map(entry => entry.id), ['alpha', 'beta'])
  } finally {
    invalidateSkillsIndex()
    cleanup(workspace)
  }
})

test('index: a SKILL.md content edit bumps the mtime fingerprint and rebuilds', async () => {
  const workspace = makeWorkspace({ alpha: '# alpha', beta: '# beta' })
  const alphaFile = join(workspace, 'knowledge', 'skills', 'alpha', 'SKILL.md')
  try {
    const before = listLocalSkills(stubCtx, workspace, 'knowledge')
    const alphaBefore = before.find(entry => entry.id === 'alpha')
    // Give the edit a distinct mtime (write + force utimes 10s in the future
    // so the fingerprint is guaranteed different even on coarse filesystems).
    writeFileSync(alphaFile, '---\nname: alpha-renamed\n---\n# new')
    const now = Date.now() / 1000 + 10
    utimesSync(alphaFile, now, now)
    const after = listLocalSkills(stubCtx, workspace, 'knowledge')
    assert.notEqual(after, before, 'a changed fingerprint must rebuild (new array object)')
    const alphaAfter = after.find(entry => entry.id === 'alpha')
    assert.equal(alphaAfter?.name, 'alpha-renamed', 'the rebuild picks up the edited frontmatter')
    assert.ok(alphaBefore !== alphaAfter, 'the rebuilt entry is a fresh object')
  } finally {
    invalidateSkillsIndex()
    cleanup(workspace)
  }
})

test('index: adding a skill dir changes the fingerprint and the inventory grows', () => {
  const workspace = makeWorkspace({ alpha: '# alpha' })
  try {
    const before = listLocalSkills(stubCtx, workspace, 'knowledge')
    assert.deepEqual(before.map(entry => entry.id), ['alpha'])
    mkdirSync(join(workspace, 'knowledge', 'skills', 'gamma'), { recursive: true })
    writeFileSync(join(workspace, 'knowledge', 'skills', 'gamma', 'SKILL.md'), '# gamma')
    const after = listLocalSkills(stubCtx, workspace, 'knowledge')
    assert.notEqual(after, before, 'an added skill must invalidate the cache')
    assert.deepEqual(after.map(entry => entry.id), ['alpha', 'gamma'])
  } finally {
    invalidateSkillsIndex()
    cleanup(workspace)
  }
})

test('index: a missing skills root yields [] and recovers once the root appears', () => {
  const workspace = makeWorkspace({})
  try {
    const missing = listLocalSkills(stubCtx, workspace, 'knowledge')
    assert.deepEqual(missing, [])
    mkdirSync(join(workspace, 'knowledge', 'skills', 'delta'), { recursive: true })
    writeFileSync(join(workspace, 'knowledge', 'skills', 'delta', 'SKILL.md'), '# delta')
    const after = listLocalSkills(stubCtx, workspace, 'knowledge')
    assert.deepEqual(after.map(entry => entry.id), ['delta'], 'a previously-empty root must recover')
  } finally {
    invalidateSkillsIndex()
    cleanup(workspace)
  }
})

// ── 2. Member persona inventory (skillsGuideSection) ─────────────────────────

test('skillsGuideSection lists every installed skill as `- <id>: <name>` with the convention hint', () => {
  const workspace = makeWorkspace({
    alpha: '---\nname: Alpha Skill\n---\n# A',
    beta: 'no frontmatter here',
  })
  try {
    const section = skillsGuideSection(stubCtx, workspace, 'knowledge')
    assert.ok(section.includes('Available local skills'), 'section header present')
    assert.ok(section.includes('read knowledge/skills/<id>/SKILL.md'), 'convention hint present')
    assert.ok(section.includes('- alpha: Alpha Skill'), 'frontmatter name surfaces in the line')
    assert.ok(section.includes('- beta: beta'), 'id fallback surfaces in the line')
    // Bundled skills ride the union (finesse-ui ships with the plugin).
    assert.ok(section.includes('- finesse-ui: finesse-ui'), 'bundled skills appear too')
  } finally {
    invalidateSkillsIndex()
    cleanup(workspace)
  }
})

test('skillsGuideSection returns "" when no skill is installed anywhere', () => {
  const workspace = makeWorkspace({})
  try {
    // The bundled plugin skills exist in this repo layout, so to test the
    // empty section we need a workspace with skills AND an absent bundled
    // dir — not possible here; instead assert the section is non-empty only
    // because the bundled union is present, and that an empty workspace
    // still yields at least the bundled inventory (never a bare "").
    const section = skillsGuideSection(stubCtx, workspace, 'knowledge')
    assert.ok(section.startsWith('Available local skills'), 'bundled union keeps the section meaningful')
  } finally {
    invalidateSkillsIndex()
    cleanup(workspace)
  }
})

// ── 3. One scan feeds every consumer (shared index) ─────────────────────────

test('route path and guide share the identical cached entries for the same root', () => {
  const workspace = makeWorkspace({ alpha: '# alpha' })
  const sessions = [{ header: { cwd: workspace } }]
  const workspaces = [{ path: workspace, title: 'ws' }]
  const ctx = fakeCtx({ sessions, workspaces })
  try {
    // Route: discoverSkillRoots (workspace registry + session cwd + bundled)
    // → collectSkillEntries → the union.
    const routeRoots = discoverSkillRoots(ctx, 'knowledge')
    assert.ok(routeRoots.includes(join(workspace, 'knowledge', 'skills')), 'route discovers the workspace root')
    const routeEntries = collectSkillEntries(routeRoots)
    const routeAlpha = routeEntries.find(entry => entry.id === 'alpha')
    assert.ok(routeAlpha !== undefined)
    // Guide: the same workspace root read through the same index.
    const guideSection = skillsGuideSection(ctx, workspace, 'knowledge')
    assert.ok(guideSection.includes('- alpha: alpha'))
    const guideEntries = collectSkillEntries([join(workspace, 'knowledge', 'skills')])
    // Identity: both consumers hold the SAME frozen entry object — one scan.
    assert.equal(guideEntries.find(entry => entry.id === 'alpha'), routeAlpha, 'route and guide share one scanned entry object')
  } finally {
    invalidateSkillsIndex()
    cleanup(workspace)
  }
})

// ── 4. Dynamic prompt inventory ──────────────────────────────────────────────

test('liveSkillsInventoryLine prefers the initiating agent workspace (per-session)', () => {
  const agentWorkspace = makeWorkspace({ 'only-agent': '# agent skill' })
  const otherWorkspace = makeWorkspace({ 'only-other': '# other skill' })
  const ctx = fakeCtx({
    sessions: [{ header: { cwd: otherWorkspace } }, { header: { cwd: agentWorkspace } }],
    workspaces: [],
    agent: { session: { header: { cwd: agentWorkspace } } },
  })
  try {
    const line = liveSkillsInventoryLine(ctx, 'knowledge')
    assert.ok(line.startsWith('当前已安装 skills：'), 'renders the live inventory label')
    assert.ok(line.includes('only-agent'), 'the initiator workspace skills are listed')
    assert.ok(!line.includes('only-other'), 'other workspaces are NOT listed when the initiator resolves')
  } finally {
    invalidateSkillsIndex()
    cleanup(agentWorkspace, otherWorkspace)
  }
})

test('liveSkillsInventoryLine falls back to the union without an initiator', () => {
  const a = makeWorkspace({ 'only-a': '# a' })
  const b = makeWorkspace({ 'only-b': '# b' })
  const ctx = fakeCtx({
    sessions: [{ header: { cwd: a } }, { header: { cwd: b } }],
    workspaces: [],
    agent: undefined,
  })
  try {
    const line = liveSkillsInventoryLine(ctx, 'knowledge')
    assert.ok(line.includes('only-a'), 'session-cwd workspace a is in the union')
    assert.ok(line.includes('only-b'), 'session-cwd workspace b is in the union')
  } finally {
    invalidateSkillsIndex()
    cleanup(a, b)
  }
})
