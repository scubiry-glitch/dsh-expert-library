/**
 * Honest minimal serving of the `zhijian.expert-memory` domain knowledge base
 * (architecture audit gap #3 "declared but not served").
 *
 * The manifest declares a `database`-kind knowledge provider
 * (`zhijian-expert-memory`) and every zhijian scenario requires it, but
 * nothing served it: there is no query tool. This module gives members the
 * next best honest serving — a persona-guide section that points them at the
 * entity content on disk, built pack-first from the generated
 * `domain-packs/zhijian-realestate/` directory via the real pack loader
 * (`loadPackFromDir`). Members read the records directly with their own
 * file/read tools, exactly like the local-knowledge folders.
 *
 * Trigger contract (documented):
 * - the team's scenario (TeamState.scenarioId) must be resolvable in the
 *   zhijian pack AND require `zhijian-expert-memory` — then the guide gets a
 *   3-6 line orientation over the loaded `DomainKnowledgeManifest`
 *   (ontology/snapshot/collection pointers);
 * - a generic team (scenario absent, or not a zhijian scenario) gets no
 *   section;
 * - when the pack or the `domain-knowledge/zhijian.expert-memory.json` file
 *   is missing but the scenario is a known zhijian routing scenario (every
 *   zhijian scenario requires the memory base by construction, see
 *   `src/v2/zhijian-pack.ts` `scenarioV2`), the guide degrades with a warning
 *   note — team creation never fails.
 *
 * Never throws: any lookup failure yields `''` (or the warning note), so the
 * member-persona path can never break team creation.
 * @module dsh-expert-library/zhijian/expert-memory
 */

import { join } from 'node:path'
import { loadPackFromDir, type LoadedPack } from '../v2/pack-loader.ts'
import type { DomainKnowledgeManifest } from '../v2/types.ts'
import { scenarioById } from './routing.ts'

/** Pack directory id under `<workspace>/<packsDir>/`. */
export const ZHIJIAN_PACK_DIR = 'zhijian-realestate'

/** The knowledge-provider id zhijian scenarios declare in knowledgePolicy.required. */
export const ZHIJIAN_EXPERT_MEMORY_PROVIDER = 'zhijian-expert-memory'

/** The domain-knowledge base id (the manifest file `domain-knowledge/zhijian.expert-memory.json`). */
export const ZHIJIAN_EXPERT_MEMORY_KB = 'zhijian.expert-memory'

/** Inputs for {@link expertMemoryGuideSection}. */
export interface ExpertMemoryGuideOptions {
  /** The captain's workspace root (team state parent). */
  readonly workspace: string
  /** Configured pack directory name under the workspace (default `domain-packs`). */
  readonly packsDir: string
  /** The team's scenario id, when the team was assembled from one. */
  readonly scenarioId?: string
}

/** The zhijian pack directory under one workspace. */
export function zhijianPackDir(workspace: string, packsDir: string): string {
  return join(workspace, packsDir, ZHIJIAN_PACK_DIR)
}

/** Load the zhijian pack from disk (pack-first); never throws. */
async function loadZhijianPack(workspace: string, packsDir: string): Promise<LoadedPack> {
  try {
    return await loadPackFromDir(zhijianPackDir(workspace, packsDir))
  } catch {
    // loadPackFromDir reports missing/invalid roots as diagnostics; a thrown
    // failure (e.g. an unreadable root) degrades to a failed load.
    return { pack: undefined, diagnostics: [], ok: false, source: { layer: 'domain-pack', label: `${packsDir}/${ZHIJIAN_PACK_DIR}` } }
  }
}

/** Whether a scenario's knowledge policy requires the expert-memory base. */
function requiresExpertMemory(required: readonly string[] | undefined): boolean {
  return (required ?? []).some(id => id === ZHIJIAN_EXPERT_MEMORY_PROVIDER || id === ZHIJIAN_EXPERT_MEMORY_KB)
}

/** 3-6 line orientation over the loaded manifest, pointing at the records. */
function orientationSection(packsDir: string, scenarioId: string, kb: DomainKnowledgeManifest): string {
  const packLabel = `${packsDir}/${ZHIJIAN_PACK_DIR}`
  const entityIds = kb.ontology.entities.map(entity => entity.id).join('、')
  const collectionRoots = kb.collections.map(collection => collection.root).join('、')
  return [
    `专家记忆库 ${kb.id}（场景 ${scenarioId} 必需）：${kb.boundary}`,
    `实体：${entityIds}；记录：${kb.snapshot.recordCount} 条（快照 ${kb.snapshot.id}，集合根 ${collectionRoots}/）。`,
    `内容位置：${packLabel}/experts/bk-*.json（每专家一个 Profile 记录，文件名 = 专家 id）；声明文件 ${packLabel}/domain-knowledge/${kb.id}.json；原始专家库页在 ${packLabel}/source/library/。`,
    `用法：用你的文件读取工具直接打开相关专家的记录（如 experts/bk-024.json），核对身份/领域/立场/风格/心智模型/禁区与合规信息；引用其观点时按记忆库 citation 策略注明口径与时间背景。`,
  ].join('\n')
}

/** Degradation note when the KB is required but its pack file is unavailable. */
function degradeNote(packsDir: string, scenarioId: string): string {
  return `警告：专家记忆库 ${ZHIJIAN_EXPERT_MEMORY_KB} 不可用——未在 ${packsDir}/${ZHIJIAN_PACK_DIR}/ 找到 domain-knowledge/${ZHIJIAN_EXPERT_MEMORY_KB}.json（团队创建不受影响）。专家身份信息以内置 Profile 为准；恢复该包文件后重启团队可重新注入本段。`
}

/**
 * Build the expert-memory guide section for one member persona, pack-first
 * (the on-disk zhijian pack is the inventory of record). Returns `''` when
 * the team is not a zhijian plan team requiring the memory base; a warning
 * note when it is but the file is missing; the orientation otherwise. Never
 * throws.
 */
export async function expertMemoryGuideSection(options: ExpertMemoryGuideOptions): Promise<string> {
  const { workspace, packsDir, scenarioId } = options
  if (scenarioId === undefined) return ''
  const loaded = await loadZhijianPack(workspace, packsDir)
  const pack = loaded.ok ? loaded.pack : undefined
  const scenario = pack?.scenarios.find(candidate => candidate.id === scenarioId)
  if (pack !== undefined && scenario !== undefined) {
    if (!requiresExpertMemory(scenario.knowledgePolicy.required)) return ''
    const kb = pack.domainKnowledge.find(candidate => candidate.id === ZHIJIAN_EXPERT_MEMORY_KB)
    if (kb === undefined) return degradeNote(packsDir, scenarioId)
    return orientationSection(packsDir, scenarioId, kb)
  }
  // The pack could not resolve the scenario. Degrade only for a known zhijian
  // routing scenario — every zhijian scenario requires the memory base by
  // construction (scenarioV2 in src/v2/zhijian-pack.ts stamps it).
  if (scenarioById(scenarioId) !== undefined) return degradeNote(packsDir, scenarioId)
  return ''
}
