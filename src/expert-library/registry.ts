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
import { BUILTIN_EXPERT_BY_ID } from './builtin-experts.ts'
import { BUILTIN_SCENARIO_BY_ID } from './builtin-scenarios.ts'
import { ZHIJIAN_EXPERT_BY_ID } from '../zhijian/registry.ts'
import type { Expert, ExpertLibrary, Scenario } from './types.ts'

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
  if (typeof id !== 'string' || id === '') return undefined
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

/** Validate one scenario definition at the JSON boundary. */
function parseScenario(value: unknown): Scenario | undefined {
  if (!isRecord(value)) return undefined
  const { id, name, description, experts, tasks, deliverable, knowledge } = value
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof name !== 'string' || name === '') return undefined
  if (typeof description !== 'string') return undefined
  const expertsList = Array.isArray(experts)
    ? experts.filter((item): item is string => typeof item === 'string')
    : []
  if (!Array.isArray(tasks) || !tasks.every(isRecord)) return undefined
  const taskList = tasks.map((task, index): Scenario['tasks'][number] | undefined => {
    const subject = task['subject']
    if (typeof subject !== 'string' || subject === '') return undefined
    const descriptionText = task['description']
    const expert = task['expert']
    const dependsOn = task['dependsOn']
    return {
      subject,
      ...(typeof descriptionText === 'string' ? { description: descriptionText } : {}),
      ...(typeof expert === 'string' ? { expert } : {}),
      ...(Array.isArray(dependsOn)
        && dependsOn.every((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item < tasks.length)
        ? { dependsOn }
        : {}),
      ...(index === tasks.length - 1 && (task['subject'] ?? '') === '' ? {} : {}),
    }
  })
  if (taskList.some((task) => task === undefined)) return undefined
  return {
    id, name, description,
    experts: expertsList,
    tasks: taskList as Scenario['tasks'],
    deliverable: typeof deliverable === 'string' ? deliverable : '',
    ...(typeof knowledge === 'string' ? { knowledge } : {}),
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
