/** Human-visible main-session transcript, projected from the durable append log. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { withTeamLock } from '../state.ts'
import { sessionOwnEvents } from '../harness-compat.ts'
import { captureSharedTaskContextFromEvents } from '../shared-task-context.ts'
import type { SharedTaskContext } from '../types.ts'
import { CUSTOMER_MENTION_CONTEXT_PREFIX, type CustomerMentionSelection } from './customer-mentions.ts'

export interface ConversationMessage {
  id: string
  seq: number
  role: 'user' | 'assistant'
  text: string
  time?: number
  interrupted?: boolean
  truncated?: boolean
}
export interface ConversationPage {
  messages: ConversationMessage[]
  turnFailures?: { seq: number; kind: 'quota_exceeded' | 'failed' | 'output_limit' }[]
  nextCursor: number
  hasMore: boolean
  hasEarlier?: boolean
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const PAGE_SIZE = 30
const MAX_TEXT = 100_000

/** Never use the model surface: compaction replacements must not erase or duplicate the human transcript. */
export function projectConversation(events: readonly unknown[], after = -1, latest = false, before = Number.MAX_SAFE_INTEGER): ConversationPage {
  const messages: ConversationMessage[] = []
  const turnFailures: NonNullable<ConversationPage['turnFailures']> = []
  let nextCursor = after
  let hasEarlier = false
  for (const event of events) {
    if (!record(event) || !Number.isSafeInteger(event.seq) || (event.seq as number) <= after) continue
    const seq = event.seq as number
    if (seq >= before) continue
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') { nextCursor = seq; continue }
    const data = event.data
    if (event.type === 'turn/end' && record(data) && record(data.reason)
      && (data.reason.kind === 'error' || data.reason.kind === 'max-tokens')) {
      const code = record(data.reason.error) ? data.reason.error.code : undefined
      turnFailures.push({ seq, kind: data.reason.kind === 'max-tokens' ? 'output_limit'
        : code === 'QUOTA' || code === 'QUOTA_EXCEEDED' ? 'quota_exceeded' : 'failed' })
      if (turnFailures.length > PAGE_SIZE) turnFailures.shift()
      nextCursor = seq
      continue
    }
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined
    if (role === undefined || !record(data)) { nextCursor = seq; continue }
    const message = role === 'user' ? data : data.message
    if (!record(message) || !Array.isArray(message.content)
      || (role === 'user' && (!record(message.source) || message.source.kind !== 'user'))) { nextCursor = seq; continue }
    const text = message.content.filter(item => record(item) && item.type === 'text' && typeof item.text === 'string'
      && (role !== 'user' || !(item.text as string).startsWith(CUSTOMER_MENTION_CONTEXT_PREFIX)))
      .map(item => (item as { text: string }).text).join('\n').trim()
    if (!text) { nextCursor = seq; continue }
    if (messages.length === PAGE_SIZE) {
      if (!latest) return { messages, nextCursor, hasMore: true, ...(turnFailures.length ? { turnFailures } : {}) }
      messages.shift(); hasEarlier = true
    }
    messages.push({ id: typeof message.id === 'string' ? message.id : `event-${seq}`, seq, role,
      text: text.slice(0, MAX_TEXT), ...(text.length > MAX_TEXT ? { truncated: true } : {}),
      ...(typeof event.time === 'number' && Number.isFinite(event.time) ? { time: event.time } : {}),
      ...(role === 'assistant' && data.interrupted === true ? { interrupted: true } : {}),
    })
    nextCursor = seq
  }
  return { messages, nextCursor, hasMore: false, ...(hasEarlier ? { hasEarlier: true } : {}),
    ...(turnFailures.length ? { turnFailures } : {}) }
}

interface Observation {
  header: { id: string; origin?: string }
  inheritedEventCount: number
  events: readonly unknown[]
  [Symbol.dispose](): void
}
interface Query {
  observeSession(id: string, options: { projectionMode: 'none'; signal: AbortSignal }): Promise<Observation>
}

/** Read attached or cold sessions without resuming an agent or starting a model turn. */
export async function readReviewConversation(ctx: Context, captainSessionId: string, after: number, latest = false, before = Number.MAX_SAFE_INTEGER): Promise<ConversationPage> {
  const query = ctx.get('sessionQuery') as Query | undefined
  if (query?.observeSession) {
    const observation = await query.observeSession(captainSessionId, { projectionMode: 'none', signal: AbortSignal.timeout(15_000) })
    try {
      if (observation.header.id !== captainSessionId || observation.header.origin === 'subagent') throw Error('REVIEW_CONVERSATION_UNAVAILABLE')
      return projectConversation(observation.events.slice(observation.inheritedEventCount), after, latest, before)
    } finally { observation[Symbol.dispose]() }
  }
  const captain = ctx.agents.get(captainSessionId as SessionId)
  if (!captain || captain.session.header.id !== captainSessionId || captain.session.header.origin === 'subagent') throw Error('REVIEW_CONVERSATION_UNAVAILABLE')
  return projectConversation(sessionOwnEvents(captain.session), after, latest, before)
}

/** Read the exact direct-user snapshot used by the approval guard, without resuming a captain. */
export async function readReviewSharedTaskContext(ctx: Context, captainSessionId: string, previous?: SharedTaskContext): Promise<SharedTaskContext> {
  const query = ctx.get('sessionQuery') as Query | undefined
  if (query?.observeSession) {
    const observation = await query.observeSession(captainSessionId, { projectionMode: 'none', signal: AbortSignal.timeout(15_000) })
    try {
      if (observation.header.id !== captainSessionId || observation.header.origin === 'subagent') throw Error('REVIEW_CONTEXT_UNAVAILABLE')
      return captureSharedTaskContextFromEvents(captainSessionId, observation.events.slice(observation.inheritedEventCount), previous)
    } finally { observation[Symbol.dispose]() }
  }
  const captain = ctx.agents.get(captainSessionId as SessionId)
  if (!captain || captain.session.header.id !== captainSessionId || captain.session.header.origin === 'subagent') throw Error('REVIEW_CONTEXT_UNAVAILABLE')
  return captureSharedTaskContextFromEvents(captainSessionId, sessionOwnEvents(captain.session), previous)
}

interface PromptController {
  inspect(sessionId: string, signal: AbortSignal): Promise<{ meta: { id: string; origin?: string } }>
  prompt(request: { sessionId: string; requestId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<{ accepted: true }>
}

/** Use the Host's normal user-message admission, cold resume and durable RPC deduplication. */
export async function sendReviewMessage(ctx: Context, captainSessionId: string, text: string, requestId: string,
  mentions: readonly CustomerMentionSelection[] = []): Promise<{ accepted: true }> {
  const controller = ctx.get('sessionController') as PromptController | undefined
  if (!controller?.inspect || !controller.prompt) throw Error('REVIEW_MESSAGE_UNAVAILABLE')
  return withTeamLock(`review-message:${captainSessionId}`, async () => {
    const signal = AbortSignal.timeout(15_000)
    const source = await controller.inspect(captainSessionId, signal)
    if (source.meta.id !== captainSessionId || source.meta.origin === 'subagent') throw Error('REVIEW_MESSAGE_UNAVAILABLE')
    const content = [{ type: 'text' as const, text },
      ...(mentions.length ? [{ type: 'text' as const, text: `${CUSTOMER_MENTION_CONTEXT_PREFIX}\n${JSON.stringify(mentions)}` }] : [])]
    const receipt = await controller.prompt({ sessionId: captainSessionId, requestId, mode: 'queue', content }, signal)
    if (receipt.accepted !== true) throw Error('REVIEW_MESSAGE_UNAVAILABLE')
    return receipt
  })
}

/** A concise default for human follow-ups sent from the collaboration room only. */
export function reviewReplyGuidance(ctx: Context): string {
  const agent = ctx.agents.currentInitiator()
  if (!agent || agent.session.header.origin === 'subagent') return ''
  const events = sessionOwnEvents(agent.session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!record(event) || event.type !== 'user/message' || !record(event.data)
      || (event.surfaceOp !== undefined && event.surfaceOp !== 'append')) continue
    const source = event.data.source
    if (!record(source) || source.kind !== 'user') continue
    if (typeof source.rpcId !== 'string' || !/^review-[a-f0-9]{24}-[a-zA-Z0-9_-]{16,80}$/.test(source.rpcId)) return ''
    return '用户通过专家协作室与主会话对话，并希望回复尽可能精简。默认先用一句话给结论，必要时再列最多三条关键要点；普通回复尽量控制在100–200个中文字以内，简单确认只用一句话。过程更新只报告新的结果或阻碍，不重复任务要求、计划、工具步骤或已说明的背景。用户明确要求详细解释、长文或完整分析时按要求展开。完整报告与交付文件仍须满足原有内容、证据和验收要求，聊天中提供结论与文件链接即可。'
  }
  return ''
}
