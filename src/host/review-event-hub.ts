import type { Context } from '@deepseek-ai/cordis'
import { projectConversation, type ConversationMessage } from './review-conversation.ts'

export interface ReviewAssistantPreview { attemptId: string; text: string; truncated?: boolean }
export type ReviewSessionEvent =
  | { type: 'conversation'; message: ConversationMessage }
  | { type: 'assistant'; value: ReviewAssistantPreview | null }
  | { type: 'state' }
  | { type: 'close' }

type Listener = (event: ReviewSessionEvent) => void
interface Attempt {
  id: string
  revision: number
  nextIndex: number
  blocks: Map<number, string>
  text: string
  truncated: boolean
  timer?: ReturnType<typeof setTimeout>
}
const MAX_TEXT = 100_000
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

/** One Host subscription per event type, shared by all review windows. No agent activation. */
export function createReviewEventHub(ctx: Context): (sessionId: string, listener: Listener) => () => void {
  const listeners = new Map<string, Set<Listener>>()
  const attempts = new Map<string, Attempt>()
  const publish = (id: string, event: ReviewSessionEvent) => {
    for (const listener of listeners.get(id) ?? []) {
      try { listener(event) } catch { /* A closed browser must never break agent dispatch. */ }
    }
  }
  const preview = (attempt: Attempt): ReviewAssistantPreview => ({ attemptId: attempt.id, text: attempt.text, ...(attempt.truncated ? { truncated: true } : {}) })
  const clear = (id: string) => {
    const attempt = attempts.get(id)
    if (attempt) clearTimeout(attempt.timer)
    attempts.delete(id)
    publish(id, { type: 'assistant', value: null })
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message' || event.type === 'turn/end') clear(session.id)
    if (!listeners.get(session.id)?.size) return
    const message = projectConversation([event]).messages[0]
    if (message) publish(session.id, { type: 'conversation', message })
    if (['user/message', 'assistant/message', 'turn/start', 'turn/end', 'agent/inbox/spliced'].includes(event.type)) publish(session.id, { type: 'state' })
  }, { global: true })
  // rc.8 peers lack the type declaration; rc.1 publishes this optional event.
  // Accept only known text chunks, never reasoning, tool arguments or raw frames.
  const on = ctx.on.bind(ctx) as unknown as (name: string, callback: (value: unknown) => void, options: { global: true }) => unknown
  on('agent/assistant-stream', value => {
    if (!record(value) || !record(value.agent) || !record(value.agent.session) || !record(value.frame)) return
    const session = value.agent.session
    if (record(session.header) && session.header.origin === 'subagent') return
    const id = session.id
    const frame = value.frame
    if (typeof id !== 'string' || typeof frame.attemptId !== 'string' || !Number.isSafeInteger(frame.revision)) return
    if (frame.type === 'start') {
      clear(id)
      // Keep bounded active previews for reconnects and mid-generation opens.
      if (attempts.size >= 64) clear(attempts.keys().next().value!)
      attempts.set(id, { id: frame.attemptId, revision: frame.revision as number, nextIndex: 0, blocks: new Map(), text: '', truncated: false })
      return
    }
    const attempt = attempts.get(id)
    if (!attempt || attempt.id !== frame.attemptId) return
    if (frame.revision !== attempt.revision + 1 || frame.index !== attempt.nextIndex) { clear(id); return }
    attempt.revision = frame.revision as number
    if (frame.type === 'end') { clear(id); return }
    if (frame.type !== 'chunk') { clear(id); return }
    attempt.nextIndex++
    const chunk = frame.chunk
    if (!record(chunk) || !Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0) return
    const index = chunk.index as number
    let text: string | undefined
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text = (attempt.blocks.get(index) ?? '') + chunk.text
    if (chunk.type === 'block-end' && record(chunk.block) && chunk.block.type === 'text' && typeof chunk.block.text === 'string') text = chunk.block.text
    if (text === undefined || attempt.truncated) return
    if (attempt.blocks.size >= 128 && !attempt.blocks.has(index)) { attempt.truncated = true; return }
    attempt.blocks.set(index, text.slice(0, MAX_TEXT))
    const combined = [...attempt.blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n')
    attempt.truncated = combined.length > MAX_TEXT || text.length > MAX_TEXT
    attempt.text = combined.slice(0, MAX_TEXT)
    if (!attempt.timer && listeners.get(id)?.size) {
      attempt.timer = setTimeout(() => {
        attempt.timer = undefined
        if (attempts.get(id) === attempt) publish(id, { type: 'assistant', value: preview(attempt) })
      }, 150)
      attempt.timer.unref()
    }
  }, { global: true })
  on('agent/disposed', value => {
    if (record(value) && record(value.agent) && record(value.agent.session) && typeof value.agent.session.id === 'string') clear(value.agent.session.id)
  }, { global: true })
  ctx.effect(() => () => {
    for (const attempt of attempts.values()) clearTimeout(attempt.timer)
    attempts.clear()
    for (const id of [...listeners.keys()]) publish(id, { type: 'close' })
    listeners.clear()
  }, 'review: release assistant previews')
  return (id, listener) => {
    let subscribers = listeners.get(id)
    if (!subscribers) listeners.set(id, subscribers = new Set())
    subscribers.add(listener)
    const attempt = attempts.get(id)
    listener({ type: 'assistant', value: attempt ? preview(attempt) : null })
    return () => {
      subscribers?.delete(listener)
      if (!subscribers?.size) listeners.delete(id)
    }
  }
}
