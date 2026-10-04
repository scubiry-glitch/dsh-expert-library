import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionOwnEvents } from './harness-compat.ts'
import { deliverToMember } from './members.ts'
import type { TeamMessage } from './types.ts'

// Only this first-line receipt is parsed. Message bodies can quote other IDs
// without making those messages appear accepted. Each ID is independent of
// the other messages or their order in this particular delivery batch.
const receiptPrefix = 'Expert Teams mailbox message IDs: '
const statePolicy = 'State policy: inspect team state read-only; never edit team.json or inbox files directly; use expert_teams_* tools.'

function collectAccepted(value: unknown, accepted: Set<string>): void {
  const candidate = value as { source?: { kind?: string; plugin?: string }; content?: { type?: string; text?: string }[] } | undefined
  if (candidate?.source?.kind !== 'plugin' || candidate.source.plugin !== 'dsh-expert-library'
    || !Array.isArray(candidate.content)) return
  for (const block of candidate.content) {
    if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith(receiptPrefix)) continue
    const firstLine = block.text.split('\n', 1)[0]!
    try {
      const ids: unknown = JSON.parse(firstLine.slice(receiptPrefix.length))
      if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
        for (const id of ids) accepted.add(id)
      }
    } catch { /* Unrelated or malformed text is not an acceptance receipt. */ }
  }
}

/** Queue only durable messages not already accepted by this live child.
 * Inbox and child-owned user events survive a lost durable-mailbox ACK; no
 * process-local receipt cache is needed. A canceled, unconsumed item remains
 * eligible for delivery. Permission and attempt admission belong to callers.
 * With no live child, normal cold delivery proceeds; the caller's durable
 * mailbox lease provides idempotency, not an OS-level exactly-once transaction.
 */
export async function deliverMemberMailbox(
  ctx: Context,
  captain: Agent,
  childId: string,
  messages: readonly Pick<TeamMessage, 'id' | 'from' | 'content'>[],
  signal: AbortSignal,
): Promise<boolean> {
  if (messages.length === 0) return true
  try {
    const accepted = new Set<string>()
    const child = ctx.agents.get(childId as SessionId)
    if (child) {
      for (const item of [...(child.inbox?.nextTurn ?? []), ...(child.inbox?.nextStep ?? [])]) collectAccepted(item, accepted)
      for (const value of sessionOwnEvents(child.session)) {
        const event = value as { type?: string; data?: unknown }
        if (event.type === 'user/message') collectAccepted(event.data, accepted)
      }
    }
    const pending = messages.filter(message => {
      if (accepted.has(message.id)) return false
      accepted.add(message.id)
      return true
    })
    if (pending.length === 0) return true
    const text = `${receiptPrefix}${JSON.stringify(pending.map(message => message.id))}\n\n${statePolicy}\n\n`
      + pending.map(message => `From ${message.from}:\n${message.content}`).join('\n\n')
    return await deliverToMember(ctx, captain, childId, text, signal)
  } catch (error: unknown) {
    ctx.logger.warn(`expert-teams: mailbox delivery to member ${childId} failed: ${String(error)}`)
    return false
  }
}
