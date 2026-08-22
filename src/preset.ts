/**
 * Agent-plane entry for the Expert Library.
 *
 * The web profile mounts `index.ts` once for the host/web surface.  The
 * `zhijian` agent preset mounts this thin entry in its isolated agent realm so
 * the model-facing tools and member-selection runtime are available to that
 * preset without requiring a second copy of the web-only composition.
 */
import { Config } from './index.ts'
import type { Context } from '@deepseek-ai/cordis'
import { registerExpertTeamsTools, type ToolsConfig } from './tools.ts'
import { registerZhijianTools } from './zhijian/tools.ts'
import { registerCollabTools } from './collab/tools.ts'

export { Config }

export const name = 'expert-library-tools'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

export function apply(ctx: Context, config: Config): void {
  // The host profile mounts index.ts and owns the web routes.  This preset
  // entry deliberately registers only the model-facing tools in the isolated
  // agent realm; mounting the full host entry here would duplicate its web
  // routes for every new session.
  const runtimeConfig: ToolsConfig = {
    stateDir: config.stateDir ?? 'expert-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: config.defaultModel ?? config.memberModel,
    memberMaxDepth: config.memberMaxDepth ?? 1,
    maxMembers: config.maxMembers ?? 8,
    knowledgeDir: config.knowledgeDir ?? 'knowledge',
    packsDir: config.packsDir ?? 'domain-packs',
    toolExecution: config.toolExecution,
  }
  const core = registerExpertTeamsTools(ctx, runtimeConfig)
  registerZhijianTools(ctx, runtimeConfig, core)
  registerCollabTools(ctx, runtimeConfig, core)
}
