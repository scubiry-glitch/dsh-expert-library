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

/** Maximum SKILL.md size we download and cache (1 MiB). */
export const MAX_SKILL_BYTES = 1024 * 1024

/**
 * Strict GitHub repo validation: exactly `owner/repo` with safe path
 * segments — owner `[A-Za-z0-9-]` (1–39 chars), repo `[A-Za-z0-9._-]`
 * (1–100 chars). Anything else (extra slashes, whitespace, control
 * characters, traversal attempts) is rejected before any fetch or path use.
 */
export function isValidRepo(repo: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)
}

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

/** Fetch result: either the SKILL.md text, or a failure (optionally over the size cap). */
type SkillFetchResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly tooLarge?: boolean }

/**
 * Fetch the SKILL.md of a GitHub repo (default branch `main`, fallback
 * `master`). The body is read with a hard size cap: once the download
 * exceeds {@link MAX_SKILL_BYTES} the reader is cancelled and the fetch
 * fails, so an oversized file is never buffered or cached.
 */
async function fetchSkillMarkdown(repo: string): Promise<SkillFetchResult> {
  for (const branch of ['main', 'master']) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/SKILL.md`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok || response.body === null) continue
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let total = 0
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_SKILL_BYTES) {
          await reader.cancel()
          return { ok: false, tooLarge: true }
        }
        text += decoder.decode(value, { stream: true })
      }
      return { ok: true, text: text + decoder.decode() }
    } catch {
      // try next branch / surface later
    }
  }
  return { ok: false }
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
  const repoId = repo.trim()
  if (!isValidRepo(repoId)) {
    ctx.logger.warn(`expert-library: skill repo "${repo}" is not a valid owner/repo`)
    return {
      name: fallbackName ?? repoId,
      repo: repoId,
      unavailable: `非法 skill repo「${repoId}」：必须是 GitHub owner/repo 格式（如 Vincentwei1021/video-shotcraft）。`,
    }
  }
  const name = fallbackName ?? repoId.split('/').pop() ?? repoId
  const dir = join(workspace, knowledgeDir, SKILLS_DIR, cacheDirFor(repoId))
  const file = join(dir, 'SKILL.md')

  try {
    const cached = await readFile(file, 'utf8')
    return { name, repo: repoId, path: file }
  } catch {
    // not cached yet — fetch below
  }

  try {
    const fetched = await fetchSkillMarkdown(repoId)
    if (!fetched.ok) {
      const reason = fetched.tooLarge === true
        ? `SKILL.md 超过 ${MAX_SKILL_BYTES / 1024} KiB 体积限制`
        : `无法拉取 ${repoId} 的 SKILL.md（网络不可用？）`
      ctx.logger.warn(`expert-library: skill "${name}" (${repoId}) ${fetched.tooLarge === true ? 'exceeds the size limit' : 'could not be fetched'}`)
      return {
        name,
        repo: repoId,
        unavailable: `${reason}。可手动将 SKILL.md 放到 ${file} 后重试。`,
      }
    }
    await mkdir(dir, { recursive: true })
    await writeFile(file, fetched.text, 'utf8')
    ctx.logger.info(`expert-library: cached skill "${name}" from ${repoId}`)
    return { name, repo: repoId, path: file }
  } catch (error: unknown) {
    ctx.logger.warn(`expert-library: skill "${name}" resolution failed: ${String(error)}`)
    return {
      name,
      repo: repoId,
      unavailable: `skill ${repoId} 解析失败（${String(error)}）。可手动将 SKILL.md 放到 ${file} 后重试。`,
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
