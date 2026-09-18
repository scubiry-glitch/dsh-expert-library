/**
 * Dual-cohort compatibility seam between Expert Teams and the Harness subagent
 * runtime: dsh 0.1.0-rc.8 (`registerContinuableSetup` / `followup`) and
 * dsh 0.1.5-rc.1 (`agent/session-start` hook / internal deliverPrompt
 * protocol). Adapter pattern proven in @nanmicoder/dsh-agent-teams
 * 0.1.16-rc.3, retargeted to 0.1.5's `dsh.subagent.deliverPrompt` symbol.
 * @module dsh-expert-library/harness-compat
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Process-stable internal delivery protocol of dsh-subagent (0.1.5-rc.1). */
const deliverPrompt = Symbol.for('dsh.subagent.deliverPrompt')
/** Pre-0.1.5 internal FIFO delivery, tolerated but never required. */
const legacyQueuePrompt = Symbol.for('dsh.subagent.queuePrompt')

/** One fresh or cold-resumed child setup; returns the installation's teardown. */
export type ContinuableSetup = (childCtx: Context) => () => void

type SubagentsLike = Context['subagents']
type Host = Record<PropertyKey, unknown>

function unsupported(detail: string): never {
  throw new Error(
    `expert-teams: unsupported Harness subagent contract (${detail}); `
    + 'use a tested Harness version with a coherent dependency installation',
  )
}

/** Read child-owned history, excluding any descriptor inherited from a parent. */
export function sessionOwnEvents(session: Agent['session']): readonly unknown[] {
  const modern = session as { ownEvents?: () => readonly unknown[] }
  if (typeof modern.ownEvents === 'function') return modern.ownEvents.call(session)
  const legacy = session as { events?: readonly unknown[]; header?: { seedLength?: number } }
  if (!Array.isArray(legacy.events)) return unsupported('missing ownEvents/legacy session log')
  return legacy.events.slice(legacy.header?.seedLength ?? 0)
}

/**
 * Install the continuable-child setup for every fresh and cold-resumed child,
 * before its first request. Prefers the upstream per-child registration seam
 * (0.1.0); otherwise hooks session start (0.1.5), which upstream owns for
 * lifetime — the child's own ctx effect disposes the installation.
 */
export function installContinuableMemberSetup(ctx: Context, setup: ContinuableSetup): void {
  const runtime = ctx.subagents as unknown as { registerContinuableSetup?: (setup: ContinuableSetup) => void }
  if (typeof runtime.registerContinuableSetup === 'function') {
    // Cordis resolves the method's this to the accessing plugin, so its
    // disposal revokes the installation with the plugin's lifetime.
    runtime.registerContinuableSetup.call(ctx.subagents, setup)
    return
  }
  const installed = new WeakSet<object>()
  const active = new Set<() => void>()
  ctx.effect(() => {
    const stop = ctx.on('agent/session-start', function (this: Context, { agent }: { agent: Agent }) {
      // rc.1 binds the listener's this to the agent's plugin-injected scoped
      // context (Scoped<Agent>). The raw `agent.ctx` payload object is
      // unwrapped — every service read on it throws "without inject".
      const childCtx = this
      if (installed.has(agent)) return
      // Deliberately synchronous: awaiting here loses the first-request race.
      let teardown: () => void
      try {
        teardown = setup(childCtx)
      } catch (error: unknown) {
        // session-start is a notification: Harness logs a thrown listener and
        // still admits the first prompt. Reject request assembly explicitly so
        // a malformed saved route cannot silently execute on a default model.
        const failure = new Error(`expert-teams: member initialization failed: ${String(error)}`, { cause: error })
        ctx.logger.warn(failure.message)
        teardown = agent.ctx.on('agent/request', () => { throw failure })
      }
      installed.add(agent)
      let disposed = false
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        active.delete(dispose)
        installed.delete(agent)
        teardown()
      }
      active.add(dispose)
      // Listeners contributed to agent.ctx already follow its lifetime. Also
      // release our bookkeeping and remove them if this plugin is reloaded.
      try {
        agent.ctx.effect(() => dispose, 'expert-teams: child compatibility setup')
      } catch (error: unknown) {
        dispose()
        throw error
      }
    })
    return () => {
      stop()
      for (const dispose of [...active]) dispose()
    }
  }, 'expert-teams: member lifecycle compatibility')
}

/**
 * Queue one host-authored turn into a member's FIFO inbox. Prefers the
 * retired upstream `followup` (0.1.0); otherwise uses the internal
 * deliverPrompt protocol in queue mode (0.1.5).
 */
export async function queueMemberPrompt(
  runtime: SubagentsLike,
  parent: Agent,
  childId: SessionId,
  content: readonly unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  const host = runtime as unknown as Host
  const source = { kind: 'plugin', plugin: 'dsh-expert-library' }
  if (typeof host.followup === 'function') {
    return (host.followup as (this: unknown, ...args: unknown[]) => Promise<unknown>)
      .call(runtime, parent, childId, content, { source, signal })
  }
  const deliver = host[deliverPrompt]
  if (typeof deliver !== 'function') {
    return unsupported(typeof host[legacyQueuePrompt] !== 'function'
      ? 'missing host FIFO delivery'
      : 'missing deliverPrompt and legacy queue delivery')
  }
  return (deliver as (this: unknown, ...args: unknown[]) => Promise<unknown>)
    .call(runtime, parent, childId, content, source, signal, 'queue')
}

/**
 * Guard every resumable delivery path (`followup`, internal queue/deliver,
 * `sendMessage`) so a retired member is rejected before it can cold-resume.
 * Returns the disposer; Cordis wraps method reads in fresh proxies, so the
 * restore compares the actual own descriptor and only removes our own
 * contribution.
 */
export function guardSubagentDelivery(
  runtime: SubagentsLike,
  isRetired: (sender: unknown, targetId: SessionId) => Promise<boolean>,
): () => void {
  const host = runtime as unknown as Host
  const legacy = host.followup
  const legacyQueue = host[legacyQueuePrompt]
  const deliver = host[deliverPrompt]
  const send = host.sendMessage
  if (typeof legacy !== 'function' && typeof deliver !== 'function'
    && typeof legacyQueue !== 'function' && typeof send !== 'function') {
    return unsupported('cannot install complete retired-member guard')
  }
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>([
    ['followup', Object.getOwnPropertyDescriptor(host, 'followup')],
    [legacyQueuePrompt, Object.getOwnPropertyDescriptor(host, legacyQueuePrompt)],
    [deliverPrompt, Object.getOwnPropertyDescriptor(host, deliverPrompt)],
    ['sendMessage', Object.getOwnPropertyDescriptor(host, 'sendMessage')],
  ])
  let active = true
  const check = async (sender: unknown, targetId: SessionId): Promise<void> => {
    if (active && await isRetired(sender, targetId)) {
      throw new SubagentError(
        `Expert Teams member "${String(targetId)}" was retired and cannot be resumed`,
        'NOT_RESUMABLE',
      )
    }
  }
  const guardedLegacy = async (parent: Agent, childId: SessionId, content: readonly unknown[], options: unknown) => {
    await check(parent, childId)
    return (legacy as (this: unknown, ...args: unknown[]) => Promise<unknown>)
      .call(runtime, parent, childId, content, options)
  }
  const guardedQueue = async (
    parent: Agent,
    childId: SessionId,
    content: readonly unknown[],
    source: unknown,
    signal: AbortSignal,
    mode: string,
  ) => {
    await check(parent, childId)
    return (host[deliverPrompt] as (this: unknown, ...args: unknown[]) => Promise<unknown>)
      .call(runtime, parent, childId, content, source, signal, mode)
  }
  const guardedSend = async (
    sender: Agent,
    targetId: SessionId,
    content: readonly unknown[],
    options: unknown,
  ) => {
    await check(sender, targetId)
    return (send as (this: unknown, ...args: unknown[]) => Promise<unknown>)
      .call(runtime, sender, targetId, content, options)
  }
  const installed = new Map<PropertyKey, unknown>()
  if (typeof legacy === 'function') {
    host.followup = guardedLegacy
    installed.set('followup', guardedLegacy)
  }
  if (typeof deliver === 'function') {
    host[deliverPrompt] = guardedQueue
    installed.set(deliverPrompt, guardedQueue)
  } else if (typeof legacyQueue === 'function') {
    host[legacyQueuePrompt] = guardedQueue
    installed.set(legacyQueuePrompt, guardedQueue)
  }
  if (typeof send === 'function') {
    host.sendMessage = guardedSend
    installed.set('sendMessage', guardedSend)
  }
  const restore = (key: PropertyKey): void => {
    if (Object.getOwnPropertyDescriptor(host, key)?.value !== installed.get(key)) return
    const original = descriptors.get(key)
    if (original === undefined) Reflect.deleteProperty(host, key)
    else Object.defineProperty(host, key, original)
  }
  return () => {
    active = false
    for (const key of installed.keys()) restore(key)
  }
}
