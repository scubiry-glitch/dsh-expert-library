/**
 * Member-level `expert_provider_call` tool — the policy-converged seam through
 * which expert members (and the captain) invoke provider capabilities.
 *
 * The tool:
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
  return summarizeEnvelope(envelope, args.capability)
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
