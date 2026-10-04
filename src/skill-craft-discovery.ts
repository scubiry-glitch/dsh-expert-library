/** Concise discovery only. Mandatory bodies are delivered after an AI selection is frozen. */
import { listScopedSkillCraftCatalog } from './skill-craft.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolsConfig } from './team-core.ts'

type Catalog = Awaited<ReturnType<typeof listScopedSkillCraftCatalog>>

export function skillCraftCatalogText(catalog: Catalog): string {
  const lines = [
    'Domain-pack craft skills — available in this session workspace and enabled pack inventory.',
    'Choose skills by the actual task and their applicability. The AI makes the choice; the Host does not choose a craft from keywords or expert roles. Multiple skills in one pack may be selected together.',
    'For reportBundle.craft.version=3, submit selections:[{packId,skillId,variant?,reason}] and evidence:"craft-evidence.json". Explain each choice. Explicitly include required skills; conflicting selections or unavailable requirements are errors, never automatic substitutions.',
    'Paths below are verified pack-owned entrypoints. Read the chosen SKILL.md. Its references resolve relative to that file. Stage freezes the installed pack/skill/material/check versions; the Host then supplies all declared mandatory role materials. Changes require a new reviewed contract, not silent fallback to global copies.',
  ]
  for (const row of catalog) {
    lines.push(JSON.stringify({
      packId: row.packId, packVersion: row.packVersion,
      skillId: row.skillId, skillVersion: row.skillVersion,
      description: row.description, applicability: row.applicability,
      variants: row.variants, requires: row.requires, conflicts: row.conflicts, artifactRoles: row.artifactRoles,
      skillPath: row.path,
    }))
  }
  if (!catalog.length) lines.push('No domain-pack craft skills are available in this session scope. Do not invent a selection or use an unverified global copy as a pack.')
  const content = lines.join('\n')
  // Never silently omit alternatives, which could bias the AI's choice.
  if (Buffer.byteLength(content) > 32 * 1024) throw new Error('SKILL_CRAFT_CATALOG_BUDGET: scoped catalog exceeds 32 KiB; narrow enabled packs before selecting a craft')
  return content
}

export async function scopedSkillCraftDiscovery(ctx: Context, config: ToolsConfig, workspace: string): Promise<{ catalog: Catalog; text: string }> {
  const catalog = await listScopedSkillCraftCatalog(ctx, config, workspace)
  return { catalog, text: skillCraftCatalogText(catalog) }
}
