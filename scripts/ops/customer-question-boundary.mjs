/** Customer portal sessions must use the question surface the portal can answer. */
import { resolve, sep } from 'node:path'

export const inject = ['tools', 'agents']

export function apply(ctx) {
  const configured = process.env.DSH_CUSTOMER_WORKSPACE_DIR
  if (!configured) return
  const root = resolve(configured)
  const customerAgent = agent => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string') return false
    const path = resolve(cwd)
    return path === root || path.startsWith(root + sep)
  }
  ctx.effect(() => {
    const unguard = ctx.tools.guard(call => call.name === 'ask_user_question' && customerAgent(call.agent)
      ? 'CUSTOMER_QUESTION_CHANNEL_REQUIRED: ask_user_question cannot be answered in the customer portal. The main session must use customer_ask_question; team members must ask the captain.'
      : undefined)
    const unassemble = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      if (!customerAgent(ctx.agents.currentInitiator())) return assembly
      return { ...assembly, tools: assembly.tools.filter(tool => tool.name !== 'ask_user_question') }
    })
    return () => { unassemble(); unguard() }
  })
}
