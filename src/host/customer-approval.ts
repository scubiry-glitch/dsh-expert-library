import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

type Decision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type Request = { agent: { session: { id: string } }; toolName: string; reason?: string; signal?: AbortSignal }
type Pending = { id: string; sessionId: string; toolName: string; reason: string; resolve: (decision: Decision) => void }

/** Present C account report generation approvals in the customer portal. */
export function createCustomerApprovalHub(ctx: Context) {
  const pending = new Map<string, Pending>()
  const events = ctx as unknown as { on(name: 'approval/request', listener: (request: Request, next: () => Promise<Decision>) => Promise<Decision>, options: { prepend: boolean }): void }
  events.on('approval/request', (request: Request, next: () => Promise<Decision>) => {
    if (request.toolName !== 'expert_provider_call'
      || !request.reason?.includes('rongcheng/api/v2/capabilities/report.generate')) return next()
    const sessionId = request.agent?.session?.id
    if (typeof sessionId !== 'string' || !/^session-[0-9a-f-]{36}$/i.test(sessionId)) return next()
    if (pending.has(sessionId)) return Promise.resolve('rejected' as const)
    return new Promise<Decision>(resolve => {
      const id = randomUUID()
      const finish = (decision: Decision) => {
        const current = pending.get(sessionId)
        if (current?.id !== id) return
        pending.delete(sessionId)
        request.signal?.removeEventListener('abort', abort)
        resolve(decision)
      }
      const abort = () => finish('cancelled')
      pending.set(sessionId, { id, sessionId, toolName: request.toolName,
        reason: '生成福州脱敏样例的四份 Word 报告', resolve: finish })
      if (request.signal?.aborted) abort()
      else request.signal?.addEventListener('abort', abort, { once: true })
    })
  }, { prepend: true })
  return {
    read: (sessionId: string) => {
      const item = pending.get(sessionId)
      return item ? { id: item.id, toolName: item.toolName, reason: item.reason } : null
    },
    answer: (sessionId: string, id: string, decision: 'allowed-once' | 'rejected') => {
      const item = pending.get(sessionId)
      if (!item || item.id !== id) return false
      item.resolve(decision)
      return true
    },
  }
}
