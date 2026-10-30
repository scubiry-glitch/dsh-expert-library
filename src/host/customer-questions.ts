import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export interface CustomerQuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
}
export interface CustomerQuestionAnswer { id: string; selected: string[]; custom?: string }
export interface CustomerQuestionCard { requestId: string; questions: CustomerQuestionItem[] }

interface Pending extends CustomerQuestionCard {
  resolve(value: { answers: CustomerQuestionAnswer[] }): void
  reject(error: Error): void
  cleanup(): void
}

export class CustomerQuestionHub {
  private readonly pending = new Map<string, Pending>()

  read(sessionId: string): CustomerQuestionCard | null {
    const found = this.pending.get(sessionId)
    return found ? { requestId: found.requestId, questions: found.questions } : null
  }

  ask(sessionId: string, questions: CustomerQuestionItem[], signal?: AbortSignal): Promise<{ answers: CustomerQuestionAnswer[] }> {
    if (this.pending.has(sessionId)) throw new Error('QUESTION_ALREADY_PENDING')
    if (signal?.aborted) throw new Error('QUESTION_ABORTED')
    const requestId = randomUUID()
    return new Promise((resolveAnswer, rejectAnswer) => {
      const cancel = () => {
        const current = this.pending.get(sessionId)
        if (current?.requestId !== requestId) return
        this.pending.delete(sessionId)
        current.cleanup()
        rejectAnswer(new Error('QUESTION_ABORTED'))
      }
      signal?.addEventListener('abort', cancel, { once: true })
      this.pending.set(sessionId, { requestId, questions,
        resolve: resolveAnswer, reject: rejectAnswer,
        cleanup: () => signal?.removeEventListener('abort', cancel),
      })
    })
  }

  answer(sessionId: string, requestId: string, answers: CustomerQuestionAnswer[]): boolean {
    const current = this.pending.get(sessionId)
    if (!current || current.requestId !== requestId || !Array.isArray(answers)
      || answers.length !== current.questions.length) return false
    const byId = new Map(answers.map(answer => [answer?.id, answer]))
    if (byId.size !== current.questions.length) return false
    let hasAnswer = false
    for (const question of current.questions) {
      const answer = byId.get(question.id)
      if (!answer || !Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string')
        || answer.selected.length > (question.multiSelect ? question.options.length : 1)
        || new Set(answer.selected).size !== answer.selected.length
        || answer.selected.some(label => !question.options.some(option => option.label === label))
        || (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 2000))) return false
      if (answer.selected.length || answer.custom?.trim()) hasAnswer = true
    }
    if (!hasAnswer) return false
    this.pending.delete(sessionId)
    current.cleanup()
    current.resolve({ answers: current.questions.map(question => byId.get(question.id)!) })
    return true
  }

  close(): void {
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(new Error('QUESTION_ABORTED'))
    }
    this.pending.clear()
  }
}

function validQuestions(value: unknown): value is CustomerQuestionItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return false
  const ids = new Set<string>()
  for (const question of value) {
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || typeof question.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(question.id)
      || ids.has(question.id) || typeof question.question !== 'string' || !question.question.trim()
      || question.question.length > 500 || (question.header !== undefined && (typeof question.header !== 'string' || question.header.length > 80))
      || (question.detail !== undefined && (typeof question.detail !== 'string' || question.detail.length > 1000))
      || !Array.isArray(question.options) || question.options.length > 8
      || typeof question.multiSelect !== 'boolean') return false
    ids.add(question.id)
    const labels = new Set<string>()
    for (const option of question.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)
        || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 100
        || labels.has(option.label) || (option.description !== undefined
          && (typeof option.description !== 'string' || option.description.length > 250))) return false
      labels.add(option.label)
    }
  }
  return true
}

/** Model tool for the customer portal only; the answer returns to this same turn. */
export function registerCustomerQuestionTool(ctx: Context, workspaceRoot: string, hub: CustomerQuestionHub): void {
  ctx.tools.register(defineTool({
    name: 'customer_ask_question',
    description: '在智见客户会话中向用户展示结构化提问卡并等待回答。每项可勾选，末行总有自定义输入；用户提交后继续本轮。仅当确实需要补齐信息或选择时调用，不要用来请求批准危险操作。',
    parameters: {
      questions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        question: { type: 'string', required: true },
        header: { type: 'string' },
        detail: { type: 'string' },
        options: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          label: { type: 'string', required: true }, description: { type: 'string' },
        } } },
        multiSelect: { type: 'boolean', required: true },
      } } },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      answers: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        selected: { type: 'array', required: true, items: { type: 'string' } },
        custom: { type: 'string' },
      } } },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agent = exec.agent
      const root = resolve(workspaceRoot), cwd = resolve(agent?.session.header.cwd ?? '')
      if (!agent || agent.session.header.origin === 'subagent'
        || (cwd !== root && !cwd.startsWith(resolve(root, 'spaces') + sep))) throw new Error('QUESTION_NOT_CUSTOMER_SESSION')
      if (!validQuestions(args.questions)) throw new Error('INVALID_QUESTIONS')
      return hub.ask(agent.session.header.id, args.questions, exec.signal)
    },
  }))
}
