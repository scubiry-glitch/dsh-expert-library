/**
 * Knowledge pack access layer.
 *
 * Knowledge packs are plain files under the captain workspace:
 *   <knowledgeDir>/experts/<expertId>/…      expert-specific material
 *   <knowledgeDir>/scenarios/<scenarioId>/…  scenario material
 *   <knowledgeDir>/shared/…                  shared material
 *
 * The plugin never parses pack contents itself (models read them with their
 * own file/read tools); this layer only (a) verifies the folder exists and
 * (b) builds the read-only consultation guide injected into member personas,
 * so members know exactly where the material for their role lives.
 *
 * Drop files into these folders at any time — the next spawned/woken member
 * picks them up from the guide, no rebuild or restart required.
 * @module dsh-expert-library/knowledge
 */

import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Knowledge pack root structure under one captain workspace. */
export interface KnowledgeLayout {
  /** Absolute experts folder, when it exists. */
  readonly expertsDir?: string
  /** Absolute scenarios folder, when it exists. */
  readonly scenariosDir?: string
  /** Absolute shared folder, when it exists. */
  readonly sharedDir?: string
}

/** Resolve the knowledge folders under a workspace (existence-checked). */
export async function resolveKnowledgeLayout(
  workspace: string,
  knowledgeDir: string,
): Promise<KnowledgeLayout> {
  const root = join(workspace, knowledgeDir)
  const layout: { expertsDir?: string; scenariosDir?: string; sharedDir?: string } = {}
  for (const [key, sub] of [
    ['expertsDir', 'experts'],
    ['scenariosDir', 'scenarios'],
    ['sharedDir', 'shared'],
  ] as const) {
    try {
      const stat = await readdir(join(root, sub))
      layout[key] = join(root, sub)
      if (stat.length === 0) delete layout[key]
    } catch {
      // folder absent or empty — skip
    }
  }
  return layout
}

/** List the readable files under one knowledge folder, one subdirectory level
 * deep (`dir` files plus `dir/<sub>/*` files, the latter shown with their
 * subdirectory prefix). Directory entries without files are skipped. */
export async function listKnowledgeFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files: string[] = []
    const subdirs: string[] = []
    for (const entry of entries) {
      if (entry.isFile()) files.push(entry.name)
      else if (entry.isDirectory()) subdirs.push(entry.name)
    }
    for (const sub of subdirs.sort()) {
      try {
        const nested = await readdir(join(dir, sub), { withFileTypes: true })
        for (const entry of nested) {
          if (entry.isFile()) files.push(`${sub}/${entry.name}`)
        }
      } catch {
        // unreadable subdirectory — skip
      }
    }
    return files.sort()
  } catch {
    return []
  }
}

/**
 * Build the read-only consultation guide for one member persona: where the
 * material for its expert id (and its scenario, when known) lives, plus the
 * shared folder. File names are listed so the member can open them directly.
 */
export async function knowledgeGuide(
  workspace: string,
  knowledgeDir: string,
  expertId: string,
  scenarioId?: string,
): Promise<string> {
  const layout = await resolveKnowledgeLayout(workspace, knowledgeDir)
  const lines: string[] = []

  const expertDir = layout.expertsDir === undefined ? undefined : join(layout.expertsDir, expertId)
  if (expertDir !== undefined) {
    const files = await listKnowledgeFiles(expertDir)
    if (files.length > 0) {
      lines.push(`- Expert knowledge for ${expertId} (${relative(workspace, expertDir)}/): ${files.join(', ')}`)
    }
  }

  if (scenarioId !== undefined && layout.scenariosDir !== undefined) {
    const scenarioDir = join(layout.scenariosDir, scenarioId)
    const files = await listKnowledgeFiles(scenarioDir)
    if (files.length > 0) {
      lines.push(`- Scenario knowledge for ${scenarioId} (${relative(workspace, scenarioDir)}/): ${files.join(', ')}`)
    }
  }

  if (layout.sharedDir !== undefined) {
    const files = await listKnowledgeFiles(layout.sharedDir)
    if (files.length > 0) {
      lines.push(`- Shared knowledge (${relative(workspace, layout.sharedDir)}/): ${files.join(', ')}`)
    }
  }

  if (lines.length === 0) return ''
  return `Knowledge packs available for this role (read them with your file/read tools when relevant):\n${lines.join('\n')}`
}
