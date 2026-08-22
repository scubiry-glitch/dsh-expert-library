/**
 * Local skill resolver: read an already-installed skill's SKILL.md and make
 * it available to a team as reference material.
 *
 * Skills are LOCAL-ONLY. The runtime never fetches from GitHub or any HTTP
 * endpoint and never auto-updates: a skill must be installed beforehand at
 *   <workspace>/<knowledgeDir>/skills/<safeSkillId>/SKILL.md
 * (builtin packs may also install skills into that folder offline). This
 * module performs no mkdir/write/network calls — resolution is strictly
 * read-only, and a missing/invalid skill degrades to an "unavailable" hint
 * telling the user how to install it locally.
 *
 * Path safety: the skill id must pass {@link isSafeSkillId} (single safe
 * path segment), and the resolved real path must stay under the real skills
 * root — a symlinked skill directory pointing outside the root is rejected.
 * The SKILL.md must be a regular file within the {@link MAX_SKILL_BYTES}
 * size cap (checked via stat before reading).
 * @module dsh-expert-library/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeKnowledgeId } from './knowledge.ts'
import { collectSkillEntries, localSkillRoots } from './skills-discovery.ts'

/** Skills directory name under the knowledge root. */
const SKILLS_DIR = 'skills'

/** Maximum SKILL.md size we read (1 MiB). */
export const MAX_SKILL_BYTES = 1024 * 1024

/**
 * Whether a skill id is safe as a single path segment under the skills
 * root: unicode letters/digits, `._-` inside, ≤64 chars — no separators,
 * no `..`, no whitespace, no `owner/repo` forms. Anything else is rejected
 * before any path is built.
 */
export function isSafeSkillId(id: string): boolean {
  return isSafeKnowledgeId(id)
}

/** One resolved local skill reference. */
export interface ResolvedSkill {
  /** Skill id (the folder name under `<knowledgeDir>/skills/`). */
  readonly id: string
  /** Skill display name. */
  readonly name: string
  /** Absolute path of the local SKILL.md (present when resolved). */
  readonly path?: string
  /** Why the skill is unavailable, when resolution failed. */
  readonly unavailable?: string
}

/** Install hint used by every unavailable-skill message. */
function installHint(workspace: string, knowledgeDir: string, id: string): string {
  return `请将 skill 本地安装到 ${join(workspace, knowledgeDir, SKILLS_DIR, id, 'SKILL.md')}（运行时不联网、不自动下载）。`
}

/**
 * Format the 「当前可用：…」 suggestion suffix for a list of available local
 * skill ids (the ids actually present in the skills roots at the failure
 * moment). Empty list → 「当前可用：（无）」. Exported for direct testing of the
 * empty case (which the live union rarely produces while the plugin's bundled
 * skills ship).
 */
export function availableSkillIdsText(ids: readonly string[]): string {
  if (ids.length === 0) return '\n当前可用：（无）'
  return `\n当前可用：${ids.join(', ')}。`
}

/**
 * Error-path suggestion loop: at the moment a skill reference fails, read the
 * shared skills index (the workspace's `<knowledgeDir>/skills/` plus the
 * plugin's bundled `knowledge/skills/`, deduped — the same union the
 * `/skills` discovery route and the member persona inventory report) and
 * append the currently available ids so the correction hint always offers
 * concrete alternatives.
 */
function availableSkillsSuffix(workspace: string, knowledgeDir: string): string {
  const ids = collectSkillEntries(localSkillRoots(workspace, knowledgeDir)).map(entry => entry.id)
  return availableSkillIdsText(ids)
}

/**
 * Resolve one locally-installed skill: strict id validation, real-path
 * containment under the skills root, regular-file check, size cap, then a
 * read-only fetch of the text. No network, no writes, no directory
 * creation — resolution failure is reported as unavailable, never thrown.
 *
 * @param ctx - the plugin context (for logging).
 * @param workspace - the captain's workspace directory.
 * @param knowledgeDir - configured knowledge directory name.
 * @param id - local skill id (folder name under `<knowledgeDir>/skills/`).
 * @param fallbackName - skill display name when the id alone is unclear.
 * @returns the resolved skill (path set on success, unavailable set otherwise).
 */
export async function resolveSkill(
  ctx: Context,
  workspace: string,
  knowledgeDir: string,
  id: string,
  fallbackName?: string,
): Promise<ResolvedSkill> {
  const skillId = id.trim()
  const name = fallbackName ?? skillId
  const suffix = () => availableSkillsSuffix(workspace, knowledgeDir)
  if (!isSafeSkillId(skillId)) {
    ctx.logger.warn(`expert-library: skill id "${id}" is not a safe local skill id`)
    return {
      id: skillId,
      name,
      unavailable: `非法 skill id「${id}」：必须是单个安全目录名（字母/数字/._-，不能包含路径分隔符或 ..）。${suffix()}`,
    }
  }

  const skillsRoot = join(workspace, knowledgeDir, SKILLS_DIR)
  const file = join(skillsRoot, skillId, 'SKILL.md')

  try {
    // Real-path containment: a symlinked skill folder (or SKILL.md) that
    // resolves outside the skills root is rejected — the skill stays local.
    const [realFile, realRoot] = await Promise.all([realpath(file), realpath(skillsRoot)])
    if (realFile !== realRoot && !realFile.startsWith(realRoot + '/') && !realFile.startsWith(realRoot + '\\')) {
      ctx.logger.warn(`expert-library: skill "${skillId}" resolves outside the skills root (symlink?) and was rejected`)
      return {
        id: skillId,
        name,
        unavailable: `skill「${skillId}」的真实路径逃逸了 skills 根目录（符号链接指向外部？），已拒绝。${installHint(workspace, knowledgeDir, skillId)}${suffix()}`,
      }
    }
    const stats = await stat(realFile)
    if (!stats.isFile()) {
      return {
        id: skillId,
        name,
        unavailable: `skill「${skillId}」的 SKILL.md 不是常规文件。${installHint(workspace, knowledgeDir, skillId)}${suffix()}`,
      }
    }
    if (stats.size > MAX_SKILL_BYTES) {
      ctx.logger.warn(`expert-library: skill "${skillId}" exceeds the size limit (${stats.size} bytes)`)
      return {
        id: skillId,
        name,
        unavailable: `SKILL.md 超过 ${MAX_SKILL_BYTES / 1024} KiB 体积限制。${suffix()}`,
      }
    }
    const text = await readFile(realFile, 'utf8')
    if (text.length === 0) {
      return {
        id: skillId,
        name,
        unavailable: `skill「${skillId}」的 SKILL.md 为空文件。${installHint(workspace, knowledgeDir, skillId)}${suffix()}`,
      }
    }
    return { id: skillId, name, path: realFile }
  } catch {
    // ENOENT (skill not installed) and any other read failure degrade to
    // an unavailable hint — a skill is an enhancement, never a blocker.
    ctx.logger.info(`expert-library: local skill "${skillId}" is not installed`)
    return {
      id: skillId,
      name,
      unavailable: `本地未安装 skill「${skillId}」。${installHint(workspace, knowledgeDir, skillId)}${suffix()}`,
    }
  }
}

/** Build the team-description block for a resolved skill. */
export function skillDescriptionBlock(skill: ResolvedSkill, purpose?: string): string {
  const purposeLine = purpose === undefined ? '' : `（用途：${purpose}）`
  if (skill.path !== undefined) {
    return `外部 skill：${skill.name}${purposeLine} — SKILL.md 位于本地 ${skill.path}，成员可用文件工具阅读并按需参考（若任务涉及该 skill 的产出物）。`
  }
  return `外部 skill：${skill.name}${purposeLine} — ${skill.unavailable ?? '当前不可用'}`
}
