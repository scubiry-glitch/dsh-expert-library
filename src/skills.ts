/**
 * External skill binding: fetch/read a skill's SKILL.md and make it available
 * to a team as reference material.
 *
 * Cache layout (workspace-level, so it survives restarts and works offline
 * after the first fetch):
 *   <workspace>/<knowledgeDir>/skills/<owner>-<repo>/SKILL.md
 *
 * The team description points members at the cached file; members read it
 * with their own file tools. A fetch failure degrades to a warning (the
 * skill is an enhancement, never a blocker for the team flow) unless the
 * caller opts into strict mode.
 * @module dsh-expert-library/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Cache directory name under the knowledge root. */
const SKILLS_DIR = 'skills'

/** One resolved skill reference. */
export interface ResolvedSkill {
  /** Skill display name. */
  readonly name: string
  /** Source repo (`owner/repo`). */
  readonly repo: string
  /** Absolute path of the cached SKILL.md (present when resolved). */
  readonly path?: string
  /** Why the skill is unavailable, when resolution failed. */
  readonly unavailable?: string
}

/** Fold a repo (`owner/repo`) into a safe cache directory name. */
function cacheDirFor(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
}

/** Fetch the SKILL.md of a GitHub repo (default branch `main`, fallback `master`). */
async function fetchSkillMarkdown(repo: string): Promise<string | undefined> {
  for (const branch of ['main', 'master']) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/SKILL.md`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (response.ok) return await response.text()
    } catch {
      // try next branch / surface later
    }
  }
  return undefined
}

/**
 * Resolve a skill binding for one captain workspace: read the local cache,
 * or fetch from GitHub and cache it.
 * @param ctx - the plugin context (for logging).
 * @param workspace - the captain's workspace directory.
 * @param knowledgeDir - configured knowledge directory name.
 * @param repo - GitHub repo (`owner/repo`) of the skill.
 * @param fallbackName - skill display name when the repo short name is unclear.
 * @returns the resolved skill (path set on success, unavailable set otherwise).
 */
export async function resolveSkill(
  ctx: Context,
  workspace: string,
  knowledgeDir: string,
  repo: string,
  fallbackName?: string,
): Promise<ResolvedSkill> {
  const name = fallbackName ?? repo.split('/').pop() ?? repo
  const dir = join(workspace, knowledgeDir, SKILLS_DIR, cacheDirFor(repo))
  const file = join(dir, 'SKILL.md')

  try {
    const cached = await readFile(file, 'utf8')
    return { name, repo, path: file }
  } catch {
    // not cached yet — fetch below
  }

  try {
    const text = await fetchSkillMarkdown(repo)
    if (text === undefined) {
      ctx.logger.warn(`expert-library: skill "${name}" (${repo}) could not be fetched`)
      return {
        name,
        repo,
        unavailable: `无法拉取 ${repo} 的 SKILL.md（网络不可用？）。可手动将 SKILL.md 放到 ${file} 后重试。`,
      }
    }
    await mkdir(dir, { recursive: true })
    await writeFile(file, text, 'utf8')
    ctx.logger.info(`expert-library: cached skill "${name}" from ${repo}`)
    return { name, repo, path: file }
  } catch (error: unknown) {
    ctx.logger.warn(`expert-library: skill "${name}" resolution failed: ${String(error)}`)
    return {
      name,
      repo,
      unavailable: `skill ${repo} 解析失败（${String(error)}）。可手动将 SKILL.md 放到 ${file} 后重试。`,
    }
  }
}

/** Build the team-description block for a resolved skill. */
export function skillDescriptionBlock(skill: ResolvedSkill, purpose?: string): string {
  const purposeLine = purpose === undefined ? '' : `（用途：${purpose}）`
  if (skill.path !== undefined) {
    return `外部 skill：${skill.name}${purposeLine} — SKILL.md 已缓存到 ${skill.path}，成员可用文件工具阅读并按需参考（若任务涉及该 skill 的产出物）。`
  }
  return `外部 skill：${skill.name}${purposeLine} — ${skill.unavailable ?? '当前不可用'}`
}
