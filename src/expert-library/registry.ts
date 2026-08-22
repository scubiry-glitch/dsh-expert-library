/**
 * Expert and scenario registry.
 *
 * Resolution order: user packs override builtins. User experts/scenarios live
 * in the captain workspace's knowledge folder as JSON files:
 *   <knowledgeDir>/experts/<id>.json        (or experts/<id>/expert.json)
 *   <knowledgeDir>/scenarios/<id>.json      (or scenarios/<id>/scenario.json)
 * Packs are scanned lazily at first use, so dropping a pack into the folder
 * takes effect without rebuilding or restarting (the next tool call picks it
 * up). Malformed pack files are skipped with a warning, never fatal.
 * @module dsh-expert-library/expert-library/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeKnowledgeId } from '../knowledge.ts'
import { isValidRepo } from '../skills.ts'
import { BUILTIN_EXPERT_BY_ID } from './builtin-experts.ts'
import { BUILTIN_SCENARIO_BY_ID } from './builtin-scenarios.ts'
import { ZHIJIAN_EXPERT_BY_ID } from '../zhijian/registry.ts'
import type { Expert, ExpertLibrary, Scenario, ScenarioSkillBinding } from './types.ts'

/** Root of a captain's knowledge packs (resolved against the workspace). */
export interface KnowledgeRoots {
  readonly expertsDir: string
  readonly scenariosDir: string
}

/** One resolved library plus the roots it was loaded from. */
export interface ResolvedLibrary extends ExpertLibrary {
  readonly roots: KnowledgeRoots
}

/** Strip a UTF-8 BOM some editors prepend to JSON files. */
function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

/** Whether a parsed JSON value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one expert definition at the JSON boundary. */
function parseExpert(value: unknown): Expert | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, role, background, principles, deliverables, model, suitedFor } = value
  // The id doubles as a knowledge folder name — only safe path segments are accepted.
  if (typeof id !== 'string' || !isSafeKnowledgeId(id)) return undefined
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof role !== 'string') return undefined
  if (typeof background !== 'string') return undefined
  const principlesList = Array.isArray(principles)
    ? principles.filter((item): item is string => typeof item === 'string')
    : []
  const deliverablesList = Array.isArray(deliverables)
    ? deliverables.filter((item): item is string => typeof item === 'string')
    : []
  const suitedList = Array.isArray(suitedFor)
    ? suitedFor.filter((item): item is string => typeof item === 'string')
    : []
  let modelRoute: Expert['model']
  if (model !== undefined) {
    if (!isRecord(model) || typeof model['provider'] !== 'string' || typeof model['model'] !== 'string') {
      return undefined
    }
    const effort = model['reasoningEffort']
    modelRoute = {
      provider: model['provider'],
      model: model['model'],
      ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
    }
  }
  return {
    id, name, role,
    background,
    principles: principlesList,
    deliverables: deliverablesList,
    ...(modelRoute === undefined ? {} : { model: modelRoute }),
    ...(suitedList.length > 0 ? { suitedFor: suitedList } : {}),
  }
}

/**
 * Validate one scenario definition at the JSON boundary.
 *
 * Strict rules:
 * - the scenario id must be a safe path segment (it becomes a knowledge folder);
 * - every `dependsOn` entry must be an integer strictly less than the task's
 *   own index — self-dependencies, forward references, out-of-range and
 *   non-integer entries all reject the scenario, which makes dependency
 *   cycles structurally impossible (tasks are created in array order and a
 *   task can only depend on already-created ones); duplicate entries are also
 *   rejected, matching the strict task-creation boundary in `tools.ts`;
 * - an optional `skill` binding is validated strictly: `repo` must match the
 *   GitHub owner/repo format and `appliesToTaskIndex` must be in range.
 *
 * Exported for unit testing at the pure input boundary.
 */
export function parseScenario(value: unknown): Scenario | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, description, experts, tasks, deliverable, knowledge, skill } = value
  if (typeof id !== 'string' || !isSafeKnowledgeId(id)) return undefined
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof description !== 'string') return undefined
  const expertsList = Array.isArray(experts)
    ? experts.filter((item): item is string => typeof item === 'string')
    : []
  if (!Array.isArray(tasks) || !tasks.every(isRecord)) return undefined
  const taskList = tasks.map((task, index): Scenario['tasks'][number] | undefined => {
    const subject = task['subject']
    if (typeof subject !== 'string' || subject.trim() === '') return undefined
    const descriptionText = task['description']
    const expert = task['expert']
    const dependsOn = task['dependsOn']
    let dependsOnList: number[] | undefined
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn)) return undefined
      const seen = new Set<number>()
      for (const item of dependsOn) {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item >= index) {
          return undefined // out of range, non-integer, self-reference or cycle-forming
        }
        if (seen.has(item)) return undefined // duplicate dependency — reject
        seen.add(item)
      }
      dependsOnList = [...dependsOn]
    }
    return {
      subject: subject.trim(),
      ...(typeof descriptionText === 'string' ? { description: descriptionText } : {}),
      ...(typeof expert === 'string' ? { expert } : {}),
      ...(dependsOnList === undefined ? {} : { dependsOn: dependsOnList }),
    }
  })
  if (taskList.some((task) => task === undefined)) return undefined
  const skillBinding = parseScenarioSkill(skill, tasks.length)
  if (skill !== undefined && skillBinding === undefined) return undefined
  return {
    id, name, description,
    experts: expertsList,
    tasks: taskList as Scenario['tasks'],
    deliverable: typeof deliverable === 'string' ? deliverable : '',
    ...(typeof knowledge === 'string' ? { knowledge } : {}),
    ...(skillBinding === undefined ? {} : { skill: skillBinding }),
  }
}

/**
 * Validate one scenario skill binding: `repo` must be a strict GitHub
 * owner/repo, `name`/`purpose` must be strings when present, and
 * `appliesToTaskIndex` must be an integer inside the task array. Returns
 * undefined when the binding is absent; rejects the whole scenario when a
 * present binding is malformed.
 */
function parseScenarioSkill(value: unknown, taskCount: number): ScenarioSkillBinding | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value['repo'] !== 'string' || !isValidRepo(value['repo'])) {
    return undefined
  }
  const name = value['name']
  const purpose = value['purpose']
  const appliesToTaskIndex = value['appliesToTaskIndex']
  if (name !== undefined && typeof name !== 'string') return undefined
  if (purpose !== undefined && typeof purpose !== 'string') return undefined
  if (appliesToTaskIndex !== undefined
    && (typeof appliesToTaskIndex !== 'number'
      || !Number.isInteger(appliesToTaskIndex)
      || appliesToTaskIndex < 0
      || appliesToTaskIndex >= taskCount)) {
    return undefined
  }
  return {
    repo: value['repo'],
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof purpose === 'string' ? { purpose } : {}),
    ...(typeof appliesToTaskIndex === 'number' ? { appliesToTaskIndex } : {}),
  }
}

/**
 * Resolve one captain's expert library: builtin definitions overlaid with
 * user packs from the workspace knowledge folder.
 * @param ctx - the plugin context (for logging).
 * @param workspace - the captain's workspace directory.
 * @param knowledgeDir - configured knowledge directory name.
 * @returns the merged library and its knowledge roots.
 */
export async function resolveLibrary(
  ctx: Context,
  workspace: string,
  knowledgeDir: string,
): Promise<ResolvedLibrary> {
  const expertsDir = join(workspace, knowledgeDir, 'experts')
  const scenariosDir = join(workspace, knowledgeDir, 'scenarios')

  const experts = new Map(BUILTIN_EXPERT_BY_ID)
  const scenarios = new Map(BUILTIN_SCENARIO_BY_ID)

  // Zhijian (智见点评) domain pack: the 32 real-estate experts are native
  // plugin data, merged below builtins so a user pack can still override.
  for (const [id, expert] of ZHIJIAN_EXPERT_BY_ID) {
    experts.set(id, expert)
  }

  await loadJsonPacks(ctx, expertsDir, (id, value) => {
    const expert = parseExpert(value)
    if (expert === undefined) {
      ctx.logger.warn(`expert-library: skipped invalid expert pack "${id}"`)
      return
    }
    experts.set(expert.id, expert)
  }, 'expert')

  await loadJsonPacks(ctx, scenariosDir, (id, value) => {
    const scenario = parseScenario(value)
    if (scenario === undefined) {
      ctx.logger.warn(`expert-library: skipped invalid scenario pack "${id}"`)
      return
    }
    scenarios.set(scenario.id, scenario)
  }, 'scenario')

  return { experts, scenarios, roots: { expertsDir, scenariosDir } }
}

/**
 * Scan a pack directory for `<id>.json` definitions (also accepting
 * `<id>/<kind>.json` subdirectories). Malformed packs are skipped with a
 * warning; unreadable directories are ignored (no packs installed yet).
 */
async function loadJsonPacks(
  ctx: Context,
  dir: string,
  accept: (id: string, value: unknown) => void,
  kind: string,
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // no pack folder yet — builtins only
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const id = entry.name.slice(0, -'.json'.length)
      if (id === '') continue
      try {
        const raw = await readFile(join(dir, entry.name), 'utf8')
        accept(id, JSON.parse(stripBom(raw)))
      } catch (error: unknown) {
        ctx.logger.warn(`expert-library: skipped unreadable ${kind} pack "${entry.name}": ${String(error)}`)
      }
    } else if (entry.isDirectory()) {
      for (const candidate of [`${kind}.json`, 'index.json']) {
        try {
          const raw = await readFile(join(dir, entry.name, candidate), 'utf8')
          accept(entry.name, JSON.parse(stripBom(raw)))
          break
        } catch (error: unknown) {
          if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue
          }
          ctx.logger.warn(`expert-library: skipped unreadable ${kind} pack "${entry.name}/${candidate}": ${String(error)}`)
          break
        }
      }
    }
  }
}
