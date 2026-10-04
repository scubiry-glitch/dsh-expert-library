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
export const MEMBER_SETUP_TIMEOUT_MS = 10_000

type SubagentsLike = Context['subagents']
type Host = Record<PropertyKey, unknown>

export interface MemberContinuableDescriptor {
  readonly mode: 'continuable'
  readonly label: string
  readonly agentProvider?: string
  readonly agentModel?: string
}

/**
 * Read the two tested descriptor cohorts without importing a version-pinned
 * fold from a different peer installation. rc.8 accepts only v2; rc.1 writes
 * v3 (adding agentReasoningEffort). Its fold would silently ignore the other
 * version, skipping every member boundary. Unknown member versions fail shut.
 */
export function memberContinuableDescriptor(
  events: readonly unknown[],
  labelPrefix: string,
): MemberContinuableDescriptor | undefined {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const event = events.find(value => record(value) && value.type === 'subagent/descriptor')
  if (!record(event) || !record(event.data)) return undefined
  const data = event.data
  if (typeof data.label !== 'string' || !data.label.startsWith(labelPrefix)) return undefined
  const fail = (detail: string): never => { throw new Error(`expert-teams: unsupported member descriptor (${detail})`) }
  if (data.version !== 2 && data.version !== 3) return fail('expected tested version 2 or 3')
  if (data.mode !== 'continuable' || typeof data.provider !== 'string') return fail('invalid member identity')
  const keys = new Set(['version', 'mode', 'provider', 'label', 'agentProvider', 'agentModel', 'persona', 'toolFilter',
    ...(data.version === 3 ? ['agentReasoningEffort'] : [])])
  if (Object.keys(data).some(key => !keys.has(key))) return fail('unknown composition field')
  for (const key of ['agentProvider', 'agentModel', 'agentReasoningEffort', 'persona']) {
    if (Object.hasOwn(data, key) && typeof data[key] !== 'string') return fail(`invalid ${key}`)
  }
  if (Object.hasOwn(data, 'toolFilter')) {
    const filter = data.toolFilter
    if (!record(filter) || Object.keys(filter).some(key => key !== 'allow' && key !== 'deny')
      || (!Object.hasOwn(filter, 'allow') && !Object.hasOwn(filter, 'deny'))) return fail('invalid toolFilter')
    for (const key of ['allow', 'deny']) {
      if (Object.hasOwn(filter, key) && (!Array.isArray(filter[key]) || !filter[key].every(item => typeof item === 'string'))) return fail(`invalid toolFilter.${key}`)
    }
  }
  return {
    mode: 'continuable', label: data.label,
    ...(typeof data.agentProvider === 'string' ? { agentProvider: data.agentProvider } : {}),
    ...(typeof data.agentModel === 'string' ? { agentModel: data.agentModel } : {}),
  }
}

/** A host-only provisioning message, consumed before a model step is entered. */
export function memberBootstrapPrompt(childId: string): string {
  return `[expert-teams:initialize-idle-member:${childId}]`
}

/**
 * startContinuable has no create-idle variant in either supported Harness.
 * Consume only our identity-bound provisioning message through the official
 * pre-step seam. Returning an empty entered step closes normally without a
 * request; later assignment/review messages still enter the ordinary inbox.
 */
export function installIdleMemberBootstrap(
  ctx: Context,
  childId: string,
  lifecycle?: { idle(): void; working(): void },
): () => void {
  const marker = memberBootstrapPrompt(childId)
  return ctx.on('agent/pre-step', async ({ messages }, next) => {
    const isBootstrap = (message: (typeof messages)[number]): boolean =>
      message.content.some(block => block.type === 'text' && block.text === marker)
    if (!messages.some(isBootstrap)) {
      if (messages.length > 0) lifecycle?.working()
      return next()
    }
    // The Host may append its own return guidance to the bootstrap message.
    // Discard that whole message, but never discard a coalesced real task.
    if (messages.every(isBootstrap)) {
      lifecycle?.idle()
      return { kind: 'enter', messages: [] }
    }
    lifecycle?.working()
    const decision = await next()
    return decision.kind === 'reject' ? decision : {
      ...decision,
      messages: decision.messages.filter(message => !isBootstrap(message)),
    }
  })
}

/**
 * Tool restrictions alone do not cover a child's own scoped registrations.
 * Filter the authoritative model assembly and install the Host's monotonic
 * final execution guard, which also covers code transport sub-dispatches.
 * These are per-agent effects and are reinstalled on every cold activation.
 */
export function installMemberToolBoundary(
  ctx: Context,
  filter: { readonly allow?: readonly string[]; readonly deny: readonly string[] },
  noDelegation: boolean,
): () => void {
  const allowed = filter.allow === undefined ? undefined : new Set(filter.allow)
  const denied = new Set(filter.deny)
  const reason = (name: string): string | undefined => {
    if (noDelegation && (name === 'subagent' || name === 'list_subagent_models')) {
      return 'expert-teams: this member has no nested delegation budget'
    }
    if (denied.has(name) || (allowed !== undefined && !allowed.has(name))) {
      return `expert-teams: tool "${name}" is outside this member's capability scope`
    }
    return undefined
  }
  if (typeof ctx.tools.guard !== 'function') return unsupported('missing monotonic tools.guard for member capability enforcement')
  const unguard = ctx.tools.guard(execution => reason(execution.name))
  try {
    const unassemble = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return { ...assembly, tools: assembly.tools.filter(tool => reason(tool.name) === undefined) }
    })
    return () => { unassemble(); unguard() }
  } catch (error) {
    unguard()
    throw error
  }
}

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
export function installContinuableMemberSetup(ctx: Context, setup: ContinuableSetup): () => void {
  const runtime = ctx.subagents as unknown as { registerContinuableSetup?: (setup: ContinuableSetup) => (() => void) | void }
  if (typeof runtime.registerContinuableSetup === 'function') {
    // Cordis resolves the method's this to the accessing plugin, so its
    // disposal revokes the installation with the plugin's lifetime.
    const dispose = runtime.registerContinuableSetup.call(ctx.subagents, setup)
    if (typeof dispose !== 'function') return unsupported('continuable setup registration has no disposer')
    return dispose
  }
  const installed = new WeakSet<object>()
  const active = new Set<() => void>()
  return ctx.effect(() => {
    const stop = ctx.on('agent/session-start', ({ agent }: { agent: Agent }) => {
      // `this` is a routing-only Scoped<Agent> carrier, never a Context. Reuse
      // the actual Host-created scope through its official inject API. This
      // also avoids importing a second dsh-scope copy: its scope tag is a
      // module-local Symbol, so a peer-mismatched createScope would not be
      // recognized by the Host's tool guards or event dispatcher.
      if (installed.has(agent)) return
      const ownEvents = sessionOwnEvents(agent.session)
      // Do not install member lifecycle gates on the captain or unrelated
      // Agents. A future/invalid member descriptor still reaches setup and
      // fails closed, rather than silently executing without its boundary.
      const isMember = ownEvents.some(event => {
        if (event === null || typeof event !== 'object') return false
        const row = event as { type?: unknown; data?: { label?: unknown } }
        return row.type === 'subagent/descriptor' && typeof row.data?.label === 'string'
          && row.data.label.startsWith('expert-teams:')
      })
      if (!isMember) return
      let ready = false
      let initializedCtx: Context | undefined
      let initializationError: Error | undefined
      let fiber: ReturnType<Context['inject']> | undefined
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      const initialization = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      // A failed mount may precede the first assembly; retain its rejection
      // for that boundary without emitting an unhandled Promise rejection.
      void initialization.catch(() => undefined)
      const fail = (cause: unknown): void => {
        if (ready || initializationError !== undefined) return
        initializationError = new Error(`expert-teams: member initialization failed: ${String(cause)}`, { cause })
        clearTimeout(timer)
        rejectReady(initializationError)
      }
      const timer = setTimeout(() => fail(new Error('member scoped setup timed out')), MEMBER_SETUP_TIMEOUT_MS)
      timer.unref()
      // Host order is assemble -> pre-step -> request. Wait at assembly,
      // before pre-step snapshots the freshly installed bootstrap listener.
      const unassemble = agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const wasReady = ready
        const signal = context.signal
        if (signal?.aborted) throw signal.reason
        let onAbort: (() => void) | undefined
        try {
          await Promise.race([initialization, new Promise<never>((_resolve, reject) => {
            if (signal === undefined) return
            onAbort = () => reject(signal.reason)
            signal.addEventListener('abort', onAbort, { once: true })
          })])
        } finally {
          if (onAbort !== undefined) signal!.removeEventListener('abort', onAbort)
        }
        // A waterfall snapshots listeners at dispatch. If setup completed
        // while it waited, recompute exactly once so the first request also
        // receives its new schema/model hooks. The inner call sees ready=true.
        return wasReady ? next() : initializedCtx!.systemPrompt.assemble(context)
      })
      try {
        fiber = agent.ctx.inject(['tools', 'llm', 'systemPrompt', 'subagents', 'agents'], runtimeCtx => {
          if (initializationError !== undefined) return
          try {
            // Current Host contexts do not publish ctx.agent. Preserve the
            // old setup interface using the identity carried by the event.
            const dispose = setup(runtimeCtx.extend({ agent }))
            runtimeCtx.effect(() => dispose, 'expert-teams: scoped member setup')
            initializedCtx = runtimeCtx
            ready = true
            clearTimeout(timer)
            resolveReady()
          } catch (error) {
            fail(error)
          }
        })
      } catch (error: unknown) {
        fail(error)
      }
      installed.add(agent)
      let disposed = false
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        active.delete(dispose)
        installed.delete(agent)
        unassemble()
        fail(new Error('member scope was disposed before setup completed'))
        clearTimeout(timer)
        if (fiber !== undefined) void Promise.resolve(fiber.dispose()).catch(error => ctx.logger.warn(`expert-teams: member scope disposal failed: ${String(error)}`))
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
    // Bounded diagnostic (≤3 per install): log the synchronous caller stack of
    // queuePrompt deliveries — used to trace the 2026-09-21 delivery retry storm.
    const q = guardedQueue as unknown as { traceN?: number }
    if ((q.traceN ??= 0) < 3) {
      q.traceN += 1
      console.error(`[guardedQueue-trace] call #${q.traceN}\n${new Error('trace').stack}`)
    }
    await check(parent, childId)
    // Call the captured implementation: the runtime's property now points to
    // this guard, and reading it again would recurse instead of delivering.
    const queue = typeof deliver === 'function' ? deliver : legacyQueue
    return (queue as (this: unknown, ...args: unknown[]) => Promise<unknown>)
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
