/**
 * Member-level `expert_provider_call` tool — the policy-converged seam through
 * which expert members (and the captain) invoke provider capabilities.
 *
 * The tool:
 * - enforces the plan's per-task capability allowlist at execute time
 *   (architecture gap #3): a member of a team assembled from a compiled
 *   ExecutionPlan may only invoke capabilities granted by their plan-linked
 *   tasks' `allowedCapabilities` (union; empty ⇒ none) — anything else fails
 *   with a never-retry `CAPABILITY_NOT_ALLOWED` BEFORE capability resolution;
 *   teams without plan capability info (legacy/ad-hoc) stay open and captains
 *   keep full access;
 * - resolves the requested capability through the ProviderTransportService's
 *   CapabilityResolver with the session's available credentials (fail closed:
 *   a missing credential or an unknown capability yields a never-retry error
 *   with the rejection reasons);
 * - lets write operations bind (`readOnly: false` at resolve time) and then
 *   defers to the service's approval gate: `service.invoke` asks the approval
 *   service when one is injected and only `'allowed-once'` grants the write;
 *   with no approval service the request stays un-approved and
 *   `registry.invoke` blocks it (`write-requires-approval`) — the tool never
 *   bypasses the gate;
 * - returns the normalized envelope with `data` bounded to
 *   {@link PROVIDER_CALL_MAX_DATA_CHARS} chars (a `truncated` marker plus a
 *   preview slice when exceeded) while `provenance`, `warnings` and `error`
 *   are preserved intact.
 *
 * Registration is guarded by {@link providerCallToolEligible} — the tool is
 * only registered when the provider service has at least one provider, so
 * webless/headless profiles never expose it.
 * @module dsh-expert-library/host/provider-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { appendTeamEvent, captainSessionOf } from '../events.ts'
import { findTeamByParticipant } from '../state.ts'
import type { ExpertTeamsProviderCalledData } from '../event-types.ts'
import type { TeamState } from '../types.ts'
import type { ProviderTransportService } from './provider-service.ts'
import type { ProviderEnvelope } from '../v2/provider-runtime.ts'

/** Max serialized chars of `data` kept in the model-facing result. */
export const PROVIDER_CALL_MAX_DATA_CHARS = 32_000

/** Model-facing result of one `expert_provider_call`. */
export interface ProviderCallResult {
  ok: boolean
  capability: string
  provider?: string
  operation?: string
  transportId?: string
  provenance?: Record<string, unknown>
  warnings?: unknown[]
  data?: unknown
  error?: Record<string, unknown>
  truncated?: Record<string, unknown>
}

const PROVIDER_CALL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    capability: { type: 'string', required: true },
    provider: { type: 'string' },
    operation: { type: 'string' },
    transportId: { type: 'string' },
    provenance: { type: 'object', additionalProperties: true },
    warnings: { type: 'array', items: { type: 'json' } },
    data: { type: 'json' },
    error: { type: 'object', additionalProperties: true },
    truncated: { type: 'object', additionalProperties: true },
  },
} as const

type ProviderCallOutput = InferValue<typeof PROVIDER_CALL_OUTPUT_SCHEMA>

const TOOL_DESCRIPTION = [
  '调用专家库 provider 能力层（Wind 金融 / 政研通 zyt / 贝壳 beike）获取数据或执行受控操作。',
  'capability 能力 id 示例：financial.stock.snapshot（Wind 行情快照）、financial.stock.quote、financial.stock.kline、financial.index.quote、financial.macro.query（Wind 宏观/EDB）、financial.fund.screen、financial.docs.search、realestate.indicators.timeseries（政研通指标时序）、realestate.indicators.catalog、realestate.city.compare（多城对比）、realestate.listing.search（贝壳房源检索）、realestate.market.trend、realestate.policy.search、realestate.geo.code 等。',
  'input 为对应 provider 契约的参数 JSON 对象（字段以该能力契约为准，如 windcode/city/code）。',
  '写/敏感操作（realestate.rent.appoint、realestate.sell.list、realestate.agent.contact 等）必须获得用户审批（allowed-once）后才执行；审批不可用或未批准时失败关闭（write-requires-approval / APPROVAL_REJECTED）。',
  '返回信封：ok / capability / provider / operation / provenance（含 caliber、unit）/ warnings / error；data 过大时截断并带 truncated 标记，provenance/warnings/error 完整保留。',
].join('\n')

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ------------------------------------------------------------------ *
 *  Plan capability gate (architecture gap #3)
 *
 *  `allowedCapabilities` on a V2 task template is a compile-time allowlist
 *  ("Capabilities this task may invoke", src/v2/types.ts TaskTemplate) — the
 *  compiler even rejects `tool-capability` input bindings outside it
 *  (src/v2/compiler.ts). The plan is immutable and never re-read after apply,
 *  so `applyExecutionPlan` persists each logical task's allowedCapabilities
 *  as `TeamState.planTaskCapabilities` (logical CompiledTask id → caps).
 *
 *  At execute time the gate resolves: caller session → team →
 *  member's plan-linked tasks (`TeamTask.planTask.logicalId`) → the union of
 *  their allowedCapabilities. When that set is defined (the team is a plan
 *  team with persisted capability info) and does not include the requested
 *  capability, the call fails with a never-retry `CAPABILITY_NOT_ALLOWED`
 *  BEFORE capability resolution — the write-approval flow is untouched (this
 *  is an additional gate in front of it).
 *
 *  Semantics (documented, ambiguity resolved):
 *  - `[]` on a task means "no tool capability allowed" — it is an allowlist,
 *    never an "unspecified" marker (the field is required and array-typed on
 *    TaskTemplate, and the compiler treats an empty list as binding nothing).
 *    A member whose resolved union is the empty set is blocked from every
 *    capability.
 *  - absent/undefined capability info — a team without
 *    `planTaskCapabilities` (legacy/ad-hoc teams, plan teams created before
 *    this field, or a member with no plan-linked task resolving to info) —
 *    behaves exactly as before: open, no constraint.
 *  - Captains (sessions without a member role) keep full access.
 * ------------------------------------------------------------------ */

/** Result of resolving a caller's plan-level capability allowance. */
export interface CapabilityAllowance {
  /** True when the plan constrains this caller (plan team + member with plan-linked tasks). */
  readonly constrained: boolean
  /** Union of allowed capabilities across the member's plan-linked tasks. */
  readonly allowed: readonly string[]
  /** Physical task ids the allowance derives from. */
  readonly fromTasks: readonly string[]
}

/**
 * Pure: resolve one caller session's capability allowance from its team
 * record. See the section doc for the exact `[]` vs `undefined` semantics.
 */
export function resolveCapabilityAllowance(team: TeamState | undefined, agentSessionId: string | undefined): CapabilityAllowance {
  const open: CapabilityAllowance = { constrained: false, allowed: [], fromTasks: [] }
  if (team === undefined || agentSessionId === undefined) return open
  // Captains (sessions without a member role) keep full access.
  if (team.captainSessionId === agentSessionId) return open
  // No plan capability info ⇒ legacy/ad-hoc team (or pre-gap plan team):
  // behave as today (open).
  const planTaskCapabilities = team.planTaskCapabilities
  if (planTaskCapabilities === undefined) return open
  const member = team.members.find(candidate => candidate.id === agentSessionId && candidate.status !== 'removed')
  if (member === undefined) return open
  const allowed: string[] = []
  const fromTasks: string[] = []
  for (const task of team.tasks) {
    if (task.assignee !== member.name) continue
    const logicalId = task.planTask?.logicalId
    if (logicalId === undefined) continue // imperative task without plan linkage
    const caps = planTaskCapabilities[logicalId]
    if (caps === undefined) continue // defensive: unknown logical id
    fromTasks.push(task.id)
    for (const cap of caps) {
      if (!allowed.includes(cap)) allowed.push(cap)
    }
  }
  // No plan-linked task resolved to capability info (rostered member with no
  // assigned plan task yet, or only unlinked tasks) ⇒ nothing constrains.
  if (fromTasks.length === 0) return open
  return { constrained: true, allowed, fromTasks }
}

/** Caller context needed by the capability gate and the audit event. */
export interface ProviderCallerContext {
  /** Durable session id of the calling agent, when it has one. */
  readonly sessionId: string | undefined
  /** Workspace root the caller's team state lives under. */
  readonly workspace: string
  /** The team the caller belongs to, when resolvable (undefined ⇒ no constraint). */
  readonly team: TeamState | undefined
}

/**
 * Resolve the caller's session + team. A missing session or any team-lookup
 * failure yields an unconstrained context (the gate stays open) so the lookup
 * can never break provider calls.
 */
export async function resolveProviderCallerContext(ctx: Context, exec: { agent?: unknown }): Promise<ProviderCallerContext> {
  const session = (exec.agent as { session?: { id?: string; header?: { cwd?: string } } } | undefined)?.session
  if (session === undefined || session.id === undefined) return { sessionId: undefined, workspace: process.cwd(), team: undefined }
  const sessionId = session.id
  const workspace = session.header?.cwd ?? process.cwd()
  try {
    const team = await findTeamByParticipant(join(workspace, 'expert-teams'), sessionId)
    return { sessionId, workspace, team }
  } catch {
    return { sessionId, workspace, team: undefined }
  }
}

/** Human correction for a blocked capability, listing the member's allowance. */
function capabilityCorrection(capability: string, allowance: CapabilityAllowance): string {
  const tasks = allowance.fromTasks.join('、')
  if (allowance.allowed.length === 0) {
    return `计划未授予该成员任何 provider 能力（其任务 ${tasks} 的 allowedCapabilities 为空），禁止调用「${capability}」`
  }
  return `计划仅允许该成员（任务 ${tasks}）调用：${allowance.allowed.join('、')}；「${capability}」不在其中，请改用允许的能力或由队长调整任务`
}

/**
 * Registration guard: the tool is only registered when the provider service
 * exists and has at least one registered provider (webless/headless profiles
 * skip silently). Also a type predicate, so the execute path is narrowed to a
 * live service after the check.
 */
export function providerCallToolEligible(service: ProviderTransportService | undefined): service is ProviderTransportService {
  return service !== undefined && service.providers.length > 0
}

/** Bound `data` to the model-facing size limit; keeps everything else intact. */
function boundData(data: unknown, maxChars: number): { readonly data: unknown; readonly truncated?: { readonly chars: number; readonly kept: number } } {
  let json: string | undefined
  try {
    json = JSON.stringify(data)
  } catch {
    return { data: { _unserializable: true } }
  }
  if (json === undefined) return { data }
  if (json.length <= maxChars) {
    let parsed: unknown = data
    try {
      parsed = JSON.parse(json)
    } catch {
      // keep the original value when it is not round-trippable
    }
    return { data: parsed }
  }
  return {
    data: {
      _truncated: true,
      _chars: json.length,
      _preview: json.slice(0, maxChars),
    },
    truncated: { chars: json.length, kept: maxChars },
  }
}

/** Project the normalized envelope into the bounded model-facing result. */
export function summarizeEnvelope(envelope: ProviderEnvelope, capability: string): ProviderCallResult {
  const base: ProviderCallResult = {
    ok: envelope.ok,
    capability,
    provider: envelope.provenance.provider,
    operation: envelope.provenance.operation,
    provenance: envelope.provenance as unknown as Record<string, unknown>,
    warnings: envelope.warnings as unknown as unknown[],
  }
  if (envelope.provenance.transportId !== undefined) base.transportId = envelope.provenance.transportId
  if (envelope.ok) {
    const { data, truncated } = boundData(envelope.data, PROVIDER_CALL_MAX_DATA_CHARS)
    base.data = data
    if (truncated !== undefined) base.truncated = truncated as unknown as Record<string, unknown>
    return base
  }
  if (envelope.error !== undefined) base.error = envelope.error as unknown as Record<string, unknown>
  return base
}

function renderProviderCallText(value: ProviderCallResult): string {
  const where = value.provider !== undefined && value.operation !== undefined
    ? `${value.provider}::${value.operation}`
    : value.capability
  if (value.ok) {
    const lines = [`[provider] ${where} 成功`]
    if (value.truncated !== undefined) {
      lines.push(`data 已截断：${String(value.truncated.chars)} 字符 → 保留 ${String(value.truncated.kept)} 字符（见 data._preview）`)
    }
    for (const warning of value.warnings ?? []) {
      if (isRecord(warning) && typeof warning['code'] === 'string') {
        lines.push(`警告 ${warning['code']}: ${typeof warning['message'] === 'string' ? warning['message'] : ''}`)
      }
    }
    return lines.join('\n')
  }
  const error = isRecord(value.error) ? value.error : undefined
  const lines = [`[provider] ${where} 失败：${typeof error?.['code'] === 'string' ? error['code'] : '未知错误'}`]
  if (typeof error?.['correction'] === 'string') lines.push(`修正：${error['correction']}`)
  if (typeof error?.['retry'] === 'string') lines.push(`重试策略：${error['retry']}`)
  return lines.join('\n')
}

async function executeProviderCall(
  ctx: Context,
  args: { capability: string; input?: unknown; context?: string },
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<ProviderCallResult> {
  const fail = (code: string, correction: string, details?: unknown): ProviderCallResult => ({
    ok: false,
    capability: args.capability,
    error: { code, retry: 'never', correction, ...(details === undefined ? {} : { details }) },
  })

  const service = ctx.get('providerTransport') as ProviderTransportService | undefined
  if (!providerCallToolEligible(service)) {
    return fail('PROVIDER_SERVICE_UNAVAILABLE', 'provider 服务未启用（当前无已注册 provider），此环境无法调用外部能力')
  }

  // Plan capability gate (architecture gap #3): BEFORE capability resolution,
  // so the write-approval flow below is untouched. Members of a plan team may
  // only invoke capabilities granted by their plan-linked tasks.
  const caller = await resolveProviderCallerContext(ctx, exec)
  const allowance = resolveCapabilityAllowance(caller.team, caller.sessionId)
  if (allowance.constrained && !allowance.allowed.includes(args.capability)) {
    return fail('CAPABILITY_NOT_ALLOWED', capabilityCorrection(args.capability, allowance), {
      allowed: [...allowance.allowed],
      tasks: [...allowance.fromTasks],
    })
  }

  const resolved = service.resolver.resolve({
    capability: args.capability,
    constraints: { availableCredentials: service.availableCredentials(), readOnly: false },
    context: args.context,
  })
  if (resolved.status !== 'bound' || resolved.binding === undefined) {
    const reasons = resolved.rejections.map(rejection => `${rejection.providerId}(${rejection.reason})`).join('; ')
    return fail('CAPABILITY_UNBOUND', `无法绑定能力「${args.capability}」：${reasons || '无候选 provider'}`, { rejections: resolved.rejections })
  }

  let envelope: ProviderEnvelope
  try {
    envelope = await service.invoke(
      { binding: resolved.binding, input: args.input ?? {}, context: args.context },
      { agent: exec.agent, signal: exec.signal },
    )
  } catch (error) {
    return fail('PROVIDER_CALL_ERROR', error instanceof Error ? error.message : String(error))
  }
  const result = summarizeEnvelope(envelope, args.capability)
  // 审计埋点：provider 调用（含失败）写入团队事件流，队长/活动面板可追踪。
  // 修复观测点「provider 失败只存在于成员口头汇报、无审计记录」。
  try {
    await emitProviderCallEvent(ctx, exec.agent, result, caller)
  } catch {
    // 事件埋点失败不阻断调用结果返回。
  }
  return result
}

/**
 * Emit an `expert-teams/provider-called` event so provider invocations
 * (especially failures) are visible to the captain and activity panel
 * instead of living only in the member's free-text report.
 * `caller` (already resolved by the capability gate) is reused to avoid a
 * second team lookup; when it did not resolve a team the previous standalone
 * lookup behavior is preserved.
 */
async function emitProviderCallEvent(ctx: Context, agent: unknown, result: ProviderCallResult, caller?: ProviderCallerContext): Promise<void> {
  const session = (agent as { session?: { id?: string; header?: { cwd?: string } } } | undefined)?.session
  const agentId = session?.id
  if (agentId === undefined || session === undefined) return
  const workspace = session.header?.cwd ?? process.cwd()
  const error = result.error as Record<string, unknown> | undefined
  const detail: ExpertTeamsProviderCalledData['detail'] = {
    capability: result.capability,
    ...(result.provider === undefined ? {} : { provider: result.provider }),
    ...(result.operation === undefined ? {} : { operation: result.operation }),
    ...(result.transportId === undefined ? {} : { transportId: result.transportId }),
    ok: result.ok,
    ...(error !== undefined && typeof error['code'] === 'string' ? { code: error['code'] } : {}),
    ...(error !== undefined && typeof error['correction'] === 'string' ? { correction: error['correction'] } : {}),
    ...(error !== undefined && typeof error['retry'] === 'string' ? { retry: error['retry'] } : {}),
  }
  try {
    const located = caller !== undefined && caller.sessionId === agentId && caller.team !== undefined
      ? caller.team
      : await findTeamByParticipant(join(workspace, 'expert-teams'), agentId)
    const fallback = ctx.agents.get(agentId as never)?.session
    appendTeamEvent(
      ctx,
      captainSessionOf(ctx, located?.captainSessionId ?? agentId, fallback ?? (session as never)),
      'expert-teams/provider-called',
      { agentId, detail },
    )
  } catch {
    // 事件埋点失败不阻断调用结果返回。
  }
}

/* ------------------------------------------------------------------ *
 *  Registration
 * ------------------------------------------------------------------ */

/**
 * Register the `expert_provider_call` tool on the shared tools registry.
 * Callers (the host plugin apply path) MUST gate this on
 * {@link providerCallToolEligible} so webless/headless profiles skip it.
 */
export function registerProviderCallTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'expert_provider_call',
    description: TOOL_DESCRIPTION,
    parameters: {
      capability: { type: 'string', required: true, description: 'provider 能力 id（如 financial.stock.snapshot、realestate.indicators.timeseries、realestate.listing.search）。' },
      input: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: '该能力契约的参数 JSON 对象（如 {"windcode":"600519.SH"} / {"city":"北京","code":"SH_PRICE"}）。',
      },
      context: { type: 'string', description: '审计上下文（任务/计划 id），透传给 provider 调用记录。' },
    },
    output: {
      schema: PROVIDER_CALL_OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: renderProviderCallText(value as unknown as ProviderCallResult) }],
    },
    async execute(args, exec) {
      return executeProviderCall(ctx, args, exec) as unknown as ProviderCallOutput
    },
  }))
}
