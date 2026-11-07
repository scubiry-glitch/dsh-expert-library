import { projectConversation, projectLatestTurn } from './review-conversation.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionOwnEvents } from '../harness-compat.ts'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
const clean = (value: unknown, max: number): string | undefined => typeof value === 'string'
  ? value.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, max) : undefined

/** Build a bounded continuation checkpoint from the session's durable events. */
export function projectRecoveryCheckpoint(events: readonly unknown[]): { turn: number; seq: number; prompt: string } | undefined {
  const latest = projectLatestTurn(events)
  if (!latest || latest.kind !== 'output_limit') return undefined
  let startSeq = -1
  for (const event of events) {
    if (!record(event) || !record(event.data) || !Number.isSafeInteger(event.seq)) continue
    if (event.type === 'turn/start' && event.data.turn === latest.turn) startSeq = event.seq as number
    if ((event.seq as number) > latest.seq && event.type === 'user/message'
      && record(event.data.source) && event.data.source.kind === 'user') return undefined
  }
  let todos: { content: string; status: string }[] = []
  let presented = 0
  const calls: { id: string; name: string }[] = []
  const returned = new Set<string>()
  for (const event of events) {
    if (!record(event) || !Number.isSafeInteger(event.seq) || (event.seq as number) > latest.seq || !record(event.data)) continue
    const data = event.data
    if (event.type === 'todo/write' && Array.isArray(data.todos)) {
      todos = data.todos.slice(0, 20).flatMap(item => {
        if (!record(item) || !['pending', 'in_progress', 'completed'].includes(String(item.status))) return []
        const content = clean(item.content, 120)
        return content ? [{ content, status: String(item.status) }] : []
      })
    }
    if (event.type === 'deliverables/presented') presented++
    if ((event.seq as number) < startSeq) continue
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string'
      && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(data.name)) calls.push({ id: data.callId, name: data.name })
    if (event.type === 'tool/result' && record(data.message) && record(data.message.source)
      && typeof data.message.source.callId === 'string') returned.add(data.message.source.callId)
  }
  const todoLines = todos.length ? todos.map(item => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.content} (${item.status})`).join('\n')
    : '- 上一轮没有结构化待办记录；先核查工作空间后建立待办。'
  const recent = calls.slice(-12)
  const returnedNames = recent.filter(item => returned.has(item.id)).map(item => item.name)
  const pendingNames = recent.filter(item => !returned.has(item.id)).map(item => item.name)
  const visible = projectConversation(events, -1, true).messages
  const lastUser = visible.filter(item => item.role === 'user' && item.seq < latest.seq).at(-1)
  const lastAssistant = visible.filter(item => item.role === 'assistant' && item.seq < latest.seq).at(-1)
  const priorContext = `${lastUser ? `最近用户要求：${clean(lastUser.text, 800)}\n` : ''}`+
    `${lastAssistant ? `此前助手报告的进展（需核验）：${clean(lastAssistant.text, 1200)}\n` : ''}`
  const prompt = `请从上轮输出截断处继续原任务。以下进度来自持久会话日志（轮次 ${latest.turn}，事件 ${latest.seq}），不是外部操作成功证明：\n\n`+
    priorContext+
    `待办进度：\n${todoLines}\n\n`+
    `本轮最近已返回的工具：${returnedNames.join('、') || '无'}；未见返回的工具：${pendingNames.join('、') || '无'}。`+
    `历史呈现交付记录 ${presented} 条。\n\n`+
    '先核对已写文件和外部发布、安装状态；任何外部写入都先查实际结果并沿用原操作标识，避免重复执行。' +
    '只完成待办中剩余的步骤；每完成一个阶段就更新待办并保存文件。分段简短报告进度，最终给出可核验的交付结果；无法完成时明确写出阻碍。'
  return { turn: latest.turn, seq: latest.seq, prompt }
}

export async function readReviewRecovery(ctx: Context, sessionId: string): Promise<{ turn: number; seq: number; prompt: string } | undefined> {
  const query = ctx.get('sessionQuery') as { observeSession?: (id: string, options: { projectionMode: 'none'; signal: AbortSignal }) => Promise<{
    header: { id: string; origin?: string }; inheritedEventCount: number; events: readonly unknown[]; [Symbol.dispose](): void
  }> } | undefined
  if (query?.observeSession) {
    const observation = await query.observeSession(sessionId, { projectionMode: 'none', signal: AbortSignal.timeout(15_000) })
    try {
      if (observation.header.id !== sessionId || observation.header.origin === 'subagent') throw Error('RECOVERY_UNAVAILABLE')
      return projectRecoveryCheckpoint(observation.events.slice(observation.inheritedEventCount))
    } finally { observation[Symbol.dispose]() }
  }
  const captain = ctx.agents.get(sessionId as SessionId)
  if (!captain || captain.session.header.id !== sessionId || captain.session.header.origin === 'subagent') throw Error('RECOVERY_UNAVAILABLE')
  return projectRecoveryCheckpoint(sessionOwnEvents(captain.session))
}
