/**
 * Local skill discovery — THE single skills index behind every consumer:
 * `GET /plugins/dsh-expert-library/skills`, the resolveSkill error-path
 * suggestion lists, the member persona skills inventory, and the dynamic
 * usage-section inventory.
 *
 * Motivation (mechanism fix): an agent that cannot find
 * `knowledge/skills/<id>/SKILL.md` must be able to enumerate what is actually
 * installed on the filesystem. Every consumer reads the same cached index
 * (`listLocalSkills` / `scanSkillsRootIndexed`) so there is exactly ONE scan
 * per skills root per fingerprint change: the scan is cached per root with an
 * mtime fingerprint (newest SKILL.md mtime + the id set — mirroring the
 * pack-cache pattern in `src/v2/compat.ts`), and an unchanged fingerprint
 * returns the same frozen array (stable identity).
 *
 * Roots scanned: each candidate workspace's `<knowledgeDir>/skills/` (the
 * workspace-registry + session-cwd union the `/state` route uses, via
 * `workspaceRootsOf`) plus the plugin's own bundled `knowledge/skills/` dir
 * (when distinct). Read-only by construction: no writes, no network.
 * Directory entries that fail `isSafeSkillId` are skipped before any path is
 * built; a missing/unreadable skills root yields zero entries, never an error.
 *
 * @module dsh-expert-library/skills-discovery
 */

import type { Context } from '@deepseek-ai/cordis'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSafeSkillId } from './skills.ts'
import { workspaceRootsOf } from './v2/preview.ts'

/** One skill row of the discovery response / index. */
export interface SkillEntry {
  /** Skill id — the folder name under `<knowledgeDir>/skills/`. */
  readonly id: string
  /** Display name: SKILL.md frontmatter `name:` when cheaply parseable, else the id. */
  readonly name: string
  /** Absolute path of the skill's SKILL.md (or the skill folder when SKILL.md is missing). */
  readonly path: string
  /** Size of SKILL.md in bytes (0 when the file is absent/unreadable). */
  readonly sizeBytes: number
  /** Whether the skill folder carries material beyond SKILL.md (references/, template/, …). */
  readonly hasReferences: boolean
}

/** Wire body of the skills route. */
export interface SkillsResponse {
  readonly skills: readonly SkillEntry[]
}

/** Bytes of SKILL.md peeked for the cheap frontmatter `name:` extraction. */
const FRONTMATTER_PEEK_BYTES = 8 * 1024

/** Skills directory name under a knowledge root (mirrors src/skills.ts). */
const SKILLS_DIR = 'skills'

/**
 * Cheaply extract the frontmatter `name:` of a SKILL.md text.
 *
 * Only the leading frontmatter block (`---` … `---`) is inspected, and only
 * a plain `name: <value>` line (single line, unquoted or single/double
 * quoted) is accepted — anything fancier falls back to `undefined` so the
 * caller uses the skill id. Never throws.
 */
export function skillNameFromFrontmatter(text: string): string | undefined {
  const head = text.slice(0, FRONTMATTER_PEEK_BYTES)
  const rest = head.startsWith('---') ? head.slice(3) : undefined
  if (rest === undefined) return undefined
  const closing = rest.indexOf('\n---')
  const block = closing === -1 ? rest : rest.slice(0, closing)
  for (const line of block.split('\n')) {
    const match = /^\s*name\s*:\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    const raw = match[1] ?? ''
    if (raw === '') return undefined
    const unquoted = raw.length >= 2
      && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw
    return unquoted
  }
  return undefined
}

/** Whether the SKILL.md text carries a parseable frontmatter name. */
export function skillNameOf(text: string, fallback: string): string {
  return skillNameFromFrontmatter(text) ?? fallback
}

/* ------------------------------------------------------------------ */
/* The cached index (mirrors the pack-cache pattern in v2/compat.ts)   */
/* ------------------------------------------------------------------ */

/** One cache entry: the fingerprint the scan was built from + the frozen scan. */
interface SkillsIndexEntry {
  /** Root fingerprint at build time; `undefined` = unstatable root (always rescan). */
  readonly fingerprint: string | undefined
  /** The frozen scan result; the same array object is returned while unchanged. */
  readonly skills: readonly SkillEntry[]
}

/** Per-root index cache: root path → fingerprint + frozen scan. */
const skillsIndex = new Map<string, SkillsIndexEntry>()

/**
 * Fingerprint of one skills root: the sorted safe-id set plus the NEWEST
 * mtime of the root's SKILL.md files (the pack-cache pattern — content edits
 * bump mtimes; the id set additionally catches add/remove exactly). `undefined`
 * when the root cannot be read — treated as "changed" so the next access
 * rebuilds (mirrors `builtinPackFingerprint`'s unstatable-dir semantics).
 */
function skillsRootFingerprint(root: string): string | undefined {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  const ids: string[] = []
  let newest = -1
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSkillId(entry.name)) continue
    ids.push(entry.name)
    try {
      const info = statSync(join(root, entry.name, 'SKILL.md'))
      if (info.isFile() && info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      // missing/unreadable SKILL.md — the id still participates in the set
    }
  }
  return `${ids.sort().join('|')}#${newest}`
}

/**
 * The single cached scan of one skills root: an unchanged fingerprint returns
 * the SAME frozen array (stable identity — route, error hints and the persona
 * guide all share one scan per root); a changed/missing fingerprint rescans
 * via the sync core and rebuilds the cache entry.
 */
export function scanSkillsRootIndexed(root: string): readonly SkillEntry[] {
  const fingerprint = skillsRootFingerprint(root)
  const cached = skillsIndex.get(root)
  if (cached !== undefined && fingerprint !== undefined && cached.fingerprint === fingerprint) {
    return cached.skills
  }
  const skills = Object.freeze(scanSkillsRootSync(root))
  skillsIndex.set(root, { fingerprint, skills })
  return skills
}

/**
 * The user-facing index read: every installed local skill under one
 * workspace's `<knowledgeDir>/skills/` (cached; see {@link scanSkillsRootIndexed}).
 * `ctx` is accepted for interface symmetry with the host consumers; the scan
 * itself is pure fs over the resolved root.
 */
export function listLocalSkills(ctx: Context, workspace: string, knowledgeDir: string): readonly SkillEntry[] {
  return scanSkillsRootIndexed(join(workspace, knowledgeDir, SKILLS_DIR))
}

/**
 * Drop the index cache — all roots, or one root. The next indexed scan
 * rebuilds lazily (used by tests and by settings-driven reloads).
 */
export function invalidateSkillsIndex(root?: string): void {
  if (root === undefined) skillsIndex.clear()
  else skillsIndex.delete(root)
}

/* ------------------------------------------------------------------ */
/* The sync scan core (the single scan implementation)                */
/* ------------------------------------------------------------------ */

/**
 * The one scan implementation (synchronous, so the prompt provider and the
 * persona guide can share it): every safe directory entry becomes a candidate
 * skill; its SKILL.md (when present) supplies the name, size and path. A skill
 * folder without SKILL.md still appears with the id as name, `hasReferences`
 * reflecting the folder content and `sizeBytes: 0`. A missing/unreadable root
 * yields `[]`, never an error.
 */
export function scanSkillsRootSync(root: string): SkillEntry[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return [] // missing or unreadable skills root — zero entries, never an error
  }
  const out: SkillEntry[] = []
  for (const entry of entries) {
    // A skill is a directory entry; a bare file at the skills root is not.
    if (!entry.isDirectory()) continue
    if (!isSafeSkillId(entry.name)) continue
    const skillDir = join(root, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    let sizeBytes = 0
    let name: string | undefined
    let hasReferences = false
    try {
      const fileInfo = statSync(skillFile)
      if (fileInfo.isFile()) {
        sizeBytes = fileInfo.size
        const text = readFileSync(skillFile, 'utf8')
        name = skillNameFromFrontmatter(text)
      }
    } catch {
      // SKILL.md absent/unreadable: the folder still counts as a skill row.
    }
    try {
      const folderEntries = readdirSync(skillDir, { withFileTypes: true })
      hasReferences = folderEntries.some(item => item.name !== 'SKILL.md')
    } catch {
      hasReferences = false
    }
    out.push({
      id: entry.name,
      name: name ?? entry.name,
      path: skillFile,
      sizeBytes,
      hasReferences,
    })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Async facade kept for API compatibility (identical results). */
export async function scanSkillsRoot(root: string): Promise<SkillEntry[]> {
  return scanSkillsRootSync(root)
}

/**
 * Union read over every given skills root, FIRST hit per skill id wins (a
 * workspace skill shadows the same id in a later root), entries id-sorted.
 * Every root is read through the shared index, so consumers that list the
 * same roots share one scan each. Synchronous (the index is sync).
 */
export function collectSkillEntries(roots: readonly string[]): SkillEntry[] {
  const byId = new Map<string, SkillEntry>()
  for (const root of roots) {
    for (const entry of scanSkillsRootIndexed(root)) {
      if (byId.has(entry.id)) continue
      byId.set(entry.id, entry)
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The roots one local consumer sees for a workspace: its
 * `<knowledgeDir>/skills/` plus the plugin's bundled `knowledge/skills/` when
 * distinct. The exact union the `/skills` route and the member persona
 * inventory report.
 */
export function localSkillRoots(workspace: string, knowledgeDir: string): string[] {
  const roots = [join(workspace, knowledgeDir, SKILLS_DIR)]
  const pluginRoot = pluginSkillsRootSync()
  if (pluginRoot !== undefined && !roots.includes(pluginRoot)) roots.push(pluginRoot)
  return roots
}

/**
 * The plugin's own bundled `knowledge/skills/` dir (sync), when it exists as a
 * directory — the inventory every consumer can rely on even when a workspace
 * has none.
 */
export function pluginSkillsRootSync(): string | undefined {
  const root = fileURLToPath(new URL('../knowledge/', import.meta.url))
  const skills = join(root, SKILLS_DIR)
  try {
    const info = statSync(skills)
    return info.isDirectory() ? skills : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the plugin's own bundled knowledge root (the `knowledge/` dir that
 * ships with the package next to `lib/`), when it exists as a directory.
 */
export async function pluginKnowledgeRoot(): Promise<string | undefined> {
  const root = fileURLToPath(new URL('../knowledge/', import.meta.url))
  try {
    const info = await stat(root)
    return info.isDirectory() ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * Mount-time inventory of the plugin's bundled skills (via the shared index):
 * safe-id filtered, sorted. Returns [] when the bundled knowledge dir is
 * absent (published layout without it).
 */
export function builtinSkillIdsSync(): string[] {
  const root = pluginSkillsRootSync()
  if (root === undefined) return []
  return scanSkillsRootIndexed(root).map(entry => entry.id)
}

/* ------------------------------------------------------------------ */
/* Prompt / persona inventory text                                    */
/* ------------------------------------------------------------------ */

/** Render one inventory line from a list of ids (never empty). */
export function skillsInventoryLine(ids: readonly string[], label: string): string {
  return ids.length === 0
    ? `${label}：无（本地 skills 目录未发现任何 skill）`
    : `${label}：${ids.join(', ')}`
}

/**
 * The Skill discovery block for `usageSectionText`: names the
 * `<workspace>/<knowledgeDir>/skills/<id>/SKILL.md` convention, states that
 * `GET /plugins/dsh-expert-library/skills` exists as the inventory channel in
 * EVERY session, folds in the given live/mount inventory line, and gives the
 * check order + the filesystem-first rule. Pure (testable).
 */
export function skillDiscoveryPromptSection(inventoryLine: string): string {
  return [
    'Skill discovery — local skills live at <workspace>/<knowledgeDir>/skills/<id>/SKILL.md (session/workspace knowledge dirs) or the plugin\'s bundled knowledge/skills/.',
    `GET /plugins/dsh-expert-library/skills lists every installed skill (id/name/path/sizeBytes/hasReferences) in every session — the channel always exists, so consult it before concluding a named skill is absent. ${inventoryLine}.`,
    'Skill reference rule: the authoritative path of a skill is the one returned by GET /plugins/dsh-expert-library/skills (the plugin bundled knowledge/skills/<id>/ when present) — never guess from a relative knowledge/skills/ path, because a subagent cwd\'s knowledge/ may have no skills/ dir; domain-packs/*/skills/ and domain-packs/*/source/skills/ are distribution copies, not lookup roots.',
    'When a task names a skill, check in order: ① the session skill catalog; ② <knowledgeDir>/skills/ on the filesystem (or GET /plugins/dsh-expert-library/skills); ③ the plugin registry; ④ the marketplace — the first hit wins.',
    'When the user asserts a skill is installed, run a filesystem search FIRST (list/read the skill folder under <knowledgeDir>/skills/ or ~/.agents/skills/) before concluding it is absent: a skill can exist on disk without being in the session catalog.',
  ].join('\n')
}

/**
 * The member-persona skills inventory section: one `- <id>: <name>` line per
 * installed local skill (workspace + bundled union, via the shared index) plus
 * the convention hint. Empty string when no skill is installed (the caller
 * omits the section then).
 */
export function skillsGuideSection(ctx: Context, workspace: string, knowledgeDir: string): string {
  const entries = collectSkillEntries(localSkillRoots(workspace, knowledgeDir))
  if (entries.length === 0) return ''
  const lines = entries.map(entry => `- ${entry.id}: ${entry.name}`)
  return [
    'Available local skills (read SKILL.md at the path returned by GET /plugins/dsh-expert-library/skills, or <workspace>/<knowledgeDir>/skills/<id>/SKILL.md / the plugin bundled knowledge/skills/<id>/SKILL.md; never a bare relative knowledge/skills/ guess):',
    ...lines,
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* Root discovery (workspace registry + session cwds + bundled)       */
/* ------------------------------------------------------------------ */

/**
 * Every candidate skills root: each registered workspace's and live session
 * cwd's `<knowledgeDir>/skills/` (the same union the `/state` route scans for
 * team state), plus the plugin's own bundled `knowledge/skills/` when it is a
 * distinct directory. Deduplicated by path so overlapping workspaces/session
 * cwds yield one scan each. Synchronous (all inputs are sync).
 */
export function discoverSkillRoots(ctx: Context, knowledgeDir: string): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  const add = (root: string): void => {
    if (root === '' || seen.has(root)) return
    seen.add(root)
    roots.push(root)
  }
  for (const workspace of workspaceRootsOf(ctx)) {
    add(join(workspace, knowledgeDir, SKILLS_DIR))
  }
  const pluginRoot = pluginSkillsRootSync()
  if (pluginRoot !== undefined) add(pluginRoot)
  return roots
}

/**
 * The initiating agent's workspace cwd, when the prompt assembly runs inside
 * an agent's driver chain (dsh-agent `currentInitiator()`). `undefined`
 * outside an initiator boundary — callers fall back to the union then.
 */
export function currentAgentWorkspace(ctx: Context): string | undefined {
  try {
    const agents = ctx.get('agents') as
      | { currentInitiator?(): { session?: { header?: { cwd?: string } } } | undefined }
      | undefined
    return agents?.currentInitiator?.()?.session?.header?.cwd
  } catch {
    return undefined
  }
}

/**
 * The live inventory line for the usage prompt: the initiating agent's own
 * workspace when resolvable (per-session), else the union of every candidate
 * workspace + bundled (which includes the current session's cwd anyway).
 * Always reads through the shared index — never a separate scan.
 */
export function liveSkillsInventoryLine(ctx: Context, knowledgeDir: string): string {
  const workspace = currentAgentWorkspace(ctx)
  const roots = workspace === undefined
    ? discoverSkillRoots(ctx, knowledgeDir)
    : localSkillRoots(workspace, knowledgeDir)
  const ids = collectSkillEntries(roots).map(entry => entry.id)
  return skillsInventoryLine(ids, '当前已安装 skills')
}
