import type { Context } from '@deepseek-ai/cordis'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
const safeCode = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
  ? value : undefined
const safeMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  return value.replace(/https?:\/\/\S+/gu, '[url]')
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/gu, '[redacted]')
    .replace(/[\r\n\t]+/gu, ' ').slice(0, 240)
}

/** Keep the underlying failure visible without putting request bodies or credentials in logs. */
export function extensionFailureDiagnostic(error: unknown, fields: readonly string[] = []): Record<string, unknown> | undefined {
  if (!record(error) || error.code !== 'REQUEST_EXTENSION') return undefined
  const causes: Record<string, string>[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 4 && record(current) && !seen.has(current); depth++) {
    seen.add(current)
    const entry: Record<string, string> = {}
    if (typeof current.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(current.name)) entry.name = current.name
    const code = safeCode(current.code)
    if (code) entry.code = code
    const message = safeMessage(current.message)
    if (message) entry.message = message
    if (typeof current.syscall === 'string' && /^[a-z]{1,32}$/.test(current.syscall)) entry.syscall = current.syscall
    if (typeof current.path === 'string') entry.path = current.path.split('/').at(-1)?.slice(0, 80) ?? ''
    causes.push(entry)
    current = current.cause
  }
  return { code: 'REQUEST_EXTENSION', fields: fields.filter(field => /^[a-z][a-z0-9_]{0,63}$/.test(field)), causes }
}

export function installLlmDiagnostics(ctx: Context): void {
  ctx.on('agent/error', payload => {
    const registry = ctx.get('deepseekLlmApiExtensions') as { providers?: Map<string, unknown> } | undefined
    const diagnostic = extensionFailureDiagnostic(payload.error, [...(registry?.providers?.keys() ?? [])])
    if (!diagnostic) return
    const sessionId = payload.agent?.session?.id
    ctx.logger.error(`expert-library: llm request extension failed ${JSON.stringify({
      ...diagnostic, sessionId, turn: payload.turn, step: payload.step,
    })}`)
  }, { global: true })
}
