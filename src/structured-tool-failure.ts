/** Narrow operational guard for repeated structured CLI failures; no domain facts. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const MAX_FAILURES = 3
const COOLDOWN_MS = 5 * 60_000
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Only complete JSON error envelopes count, never a substring inside prose/data. */
export function structuredFailureOutput(result: Readonly<ToolExecutionResult>): boolean {
  if (result.isError || !record(result.value) || result.value.exitCode !== 0
    || result.value.aborted === true || result.value.timedOut === true) return false
  const stdout = result.value.stdout
  if (!record(stdout) || stdout.truncated === true || typeof stdout.text !== 'string'
    || stdout.text.length > 32_000) return false
  const text = stdout.text.trim()
  if (!text) return false
  const failure = (value: unknown): boolean => record(value) && value.ok === false
    && (typeof value.error === 'string' && value.error.trim() !== ''
      || record(value.error) && (typeof value.error.message === 'string' || typeof value.error.code === 'string'))
  try { return failure(JSON.parse(text)) } catch { /* CLI may print repeated JSON lines. */ }
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  if (lines.length > 16) return false
  return lines.every(line => { try { return failure(JSON.parse(line)) } catch { return false } })
}

export function shellOperationKey(exec: Pick<ToolExecution, 'name' | 'arguments'>): string | undefined {
  if (exec.name !== 'bash' || !record(exec.arguments) || typeof exec.arguments.command !== 'string') return
  // Diagnostic descriptions and timeouts do not create a new operation. No shell
  // rewriting or guessed semantic equivalence; changed commands stay distinct.
  return createHash('sha256').update(JSON.stringify([exec.arguments.command,
    exec.arguments.workdir ?? null, exec.arguments.run_in_background ?? false])).digest('hex')
}

export class StructuredFailureBudget {
  private readonly agents = new WeakMap<object, Map<string, { failures: number; at: number }>>()
  denied(agent: object, key: string, now = Date.now()): boolean {
    const rows = this.agents.get(agent), row = rows?.get(key)
    if (!row) return false
    if (now - row.at >= COOLDOWN_MS) { rows!.delete(key); return false }
    return row.failures >= MAX_FAILURES
  }
  settled(agent: object, key: string, failed: boolean, now = Date.now()): number {
    let rows = this.agents.get(agent)
    if (!rows) { rows = new Map(); this.agents.set(agent, rows) }
    if (!failed) { rows.delete(key); return 0 }
    const old = rows.get(key)
    const failures = old && now - old.at < COOLDOWN_MS ? old.failures + 1 : 1
    if (rows.size >= 128 && !rows.has(key)) rows.delete(rows.keys().next().value!)
    rows.set(key, { failures, at: now }); return failures
  }
}

export function installStructuredToolFailureGuard(ctx: Context): void {
  const budget = new StructuredFailureBudget()
  const guidance = 'Preserve the actual failure as evidence. Stop repeating this operation; changing its description or shell spelling is not recovery. Continue independent work and any explicitly authorized conditional analysis. Do not fabricate missing data or mark failed checks as passed. If completion requires this source, record the external blocker and wait for actual recovery; do not sleep or poll. A new probe is possible after the five-minute cooldown, only when there is a reason to expect recovery.'
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const key = shellOperationKey(exec)
    if (exec.agent && key && budget.denied(exec.agent, key)) return {
      kind: 'deny', reason: 'REPEATED_STRUCTURED_TOOL_FAILURE: this exact shell operation already returned three structured failures. ' + guidance,
    }
    return decision
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const key = shellOperationKey(exec)
    // Respect earlier policies, cancellation, background handles and native errors.
    if (!exec.agent || !key || result.isError || decision.kind !== 'accept'
      || decision.content !== undefined || decision.value !== undefined) return decision
    const failed = structuredFailureOutput(result)
    const count = budget.settled(exec.agent, key, failed)
    if (!failed) return decision
    return { kind: 'block', feedback: [...result.content, { type: 'text',
      text: `STRUCTURED_TOOL_FAILURE: shell exit 0 did not establish business success; the complete output is an ok:false error envelope (observed failure ${count}/3). ${guidance}` }],
      ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }) }
  })
}
