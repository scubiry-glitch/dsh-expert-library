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
  // `disabledTools` filters THIS preset's tool catalog at registration time:
  // a listed tool id is never registered, so it costs no context window and
  // cannot be routed to. Tools registered by the host entry (web routes,
  // provider transport, `render_publish`) are untouched.
  const disabled = new Set(config.disabledTools ?? [])
  const scopedRegister: typeof ctx.tools.register = ((definition: Parameters<typeof ctx.tools.register>[0]) => {
    if (disabled.has(definition.name)) return
    return ctx.tools.register(definition)
  }) as typeof ctx.tools.register
  const scopedCtx = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'tools') {
        return new Proxy(target.tools, {
          get(toolTarget, toolProp, toolReceiver) {
            if (toolProp === 'register') return scopedRegister
            return Reflect.get(toolTarget, toolProp, toolReceiver)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
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
  const core = registerExpertTeamsTools(scopedCtx, runtimeConfig)
  registerZhijianTools(scopedCtx, runtimeConfig, core)
  registerCollabTools(scopedCtx, runtimeConfig, core)
}
