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
import {
  resolveDatasetRequest,
  validateDatasetProvenance,
  ZHIJIAN_DATASETS,
  type DatasetDefinition,
  type DatasetError,
} from './dataset-registry.ts'

/** Max serialized chars of `data` kept in the model-facing result. */
export const PROVIDER_CALL_MAX_DATA_CHARS = 32_000

/** Model-facing result of one `expert_provider_call`. */
export interface ProviderCallResult {
  ok: boolean
  capability: string
  dataset?: string
  datasetVersion?: string
  signature?: string
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
    dataset: { type: 'string' },
    datasetVersion: { type: 'string' },
    signature: { type: 'string' },
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
  '优先 dataset-first 调用：传 dataset（已注册数据集 id，如 realestate.city.market、realestate.listing.search、realestate.policy、realestate.rent.market、financial.stock.quote、financial.macro），系统自动映射到版本钉扎的 capability 并校验必填口径；未注册 dataset、缺口径、凭据缺失、参数错误都不会触发安装或 key 猜测，只会返回结构化修正错误。',
  '直接传 capability 仍兼容（如 financial.stock.snapshot、realestate.indicators.timeseries、realestate.city.compare），但新增业务应优先走 dataset。',
  'input 为对应能力契约的参数 JSON 对象（字段以该能力契约为准，如 windcode/city/code）。',
  '写/敏感操作（realestate.rent.appoint、realestate.sell.list、realestate.agent.contact 等）必须获得用户审批（allowed-once）后才执行；审批不可用或未批准时失败关闭（write-requires-approval / APPROVAL_REJECTED）。',
  '返回信封：ok / capability / dataset / provenance（含 caliber、unit）/ warnings / error；data 过大时截断并带 truncated 标记，provenance/warnings/error 完整保留。',
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

function dataPreviewText(data: unknown, maxChars = 6000): string | undefined {
  if (data === undefined || data === null) return undefined
  let text: string
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data)
  } catch {
    return undefined
  }
  if (typeof text !== 'string' || text === '' || text === 'undefined') return undefined
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}…（共 ${text.length} 字符，超出展示上限已截断，完整数据见结构化 data 字段）`
  }
  return text
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
    const dataPreview = dataPreviewText(value.data)
    if (dataPreview !== undefined) {
      lines.push(`data: ${dataPreview}`)
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

/* ------------------------------------------------------------------ *
 *  Dataset gate (dataset-first calling)
 *
 *  `dataset` is the model-facing contract; provider capability ids stay an
 *  implementation detail resolved (and version-pinned) by the registry. The
 *  gate runs BEFORE plan-allowance and capability resolution so contract
 *  errors (unknown dataset, version mismatch, missing caliber) surface even
 *  when the provider service is down, and never suggest reinstalling.
 * ------------------------------------------------------------------ */

/** Result of the pure dataset gate applied to raw tool args. */
export type DatasetGateResult =
  | {
      readonly ok: true
      readonly capability: string
      readonly input: Record<string, unknown>
      readonly dataset?: { readonly id: string; readonly version: string; readonly signature: string; readonly definition: DatasetDefinition }
    }
  | { readonly ok: false; readonly error: DatasetError }

/**
 * Pure: resolve raw `{ capability?, dataset?, version?, input? }` args into a
 * bound capability (+ dataset metadata) or a structured dataset error.
 */
export function applyDatasetRequest(args: { readonly capability?: string; readonly dataset?: string; readonly version?: string; readonly input?: unknown }): DatasetGateResult {
  const input = args.input
  if (args.dataset === undefined) {
    if (typeof args.capability !== 'string' || args.capability === '') {
      return { ok: false, error: { code: 'INPUT_INVALID', retry: 'never', correction: '必须提供 dataset（首选）或 capability 之一' } }
    }
    if (input !== undefined && !isRecord(input)) {
      return { ok: false, error: { code: 'INPUT_INVALID', retry: 'never', correction: 'input 必须是参数 JSON 对象' } }
    }
    return { ok: true, capability: args.capability, input: (input ?? {}) as Record<string, unknown> }
  }
  if (input === undefined || !isRecord(input)) {
    return { ok: false, error: { code: 'INPUT_INVALID', retry: 'never', correction: `dataset 调用必须提供 input 参数对象（字段见数据集契约）` } }
  }
  const resolved = resolveDatasetRequest({ dataset: args.dataset, input, ...(args.version === undefined ? {} : { version: args.version }) })
  if ('error' in resolved) return { ok: false, error: resolved.error }
  // A dataset call that ALSO names a capability must agree with the pinned
  // mapping — contradictions fail closed instead of silently rebinding.
  if (args.capability !== undefined && args.capability !== resolved.binding.id) {
    return {
      ok: false,
      error: {
        code: 'INPUT_INVALID',
        retry: 'never',
        correction: `数据集「${args.dataset}」映射到 capability「${resolved.binding.id}」，与传入的「${args.capability}」不一致；请去掉 capability 或改用映射值`,
      },
    }
  }
  return {
    ok: true,
    capability: resolved.binding.id,
    input: resolved.input,
    dataset: { id: resolved.definition.dataset, version: resolved.definition.version, signature: resolved.signature, definition: resolved.definition },
  }
}

async function executeProviderCall(
  ctx: Context,
  args: { capability?: string; dataset?: string; version?: string; input?: unknown; context?: string },
  exec: { agent?: unknown; signal?: AbortSignal },
): Promise<ProviderCallResult> {
  const fail = (code: string, correction: string, details?: unknown): ProviderCallResult => ({
    ok: false,
    capability: typeof args.capability === 'string' ? args.capability : (args.dataset ?? ''),
    ...(args.dataset !== undefined ? { dataset: args.dataset } : {}),
    error: { code, retry: 'never', correction, ...(details === undefined ? {} : { details }) },
  })

  // Dataset gate first: contract errors are independent of provider uptime.
  const gated = applyDatasetRequest(args)
  if (!gated.ok) {
    return fail(gated.error.code, gated.error.correction, gated.error.details)
  }
  const capability = gated.capability
  const datasetInfo = gated.dataset

  const service = ctx.get('providerTransport') as ProviderTransportService | undefined
  if (!providerCallToolEligible(service)) {
    return fail('PROVIDER_SERVICE_UNAVAILABLE', 'provider 服务未启用（当前无已注册 provider），此环境无法调用外部能力')
  }

  // Plan capability gate (architecture gap #3): BEFORE capability resolution,
  // so the write-approval flow below is untouched. Members of a plan team may
  // only invoke capabilities granted by their plan-linked tasks.
  const caller = await resolveProviderCallerContext(ctx, exec)
  const allowance = resolveCapabilityAllowance(caller.team, caller.sessionId)
  if (allowance.constrained && !allowance.allowed.includes(capability)) {
    return fail('CAPABILITY_NOT_ALLOWED', capabilityCorrection(capability, allowance), {
      allowed: [...allowance.allowed],
      tasks: [...allowance.fromTasks],
    })
  }

  const resolved = service.resolver.resolve({
    capability,
    constraints: { availableCredentials: service.availableCredentials(), readOnly: false },
    context: args.context,
  })
  if (resolved.status !== 'bound' || resolved.binding === undefined) {
    const reasons = resolved.rejections.map(rejection => `${rejection.providerId}(${rejection.reason})`).join('; ')
    return fail('CAPABILITY_UNBOUND', `无法绑定能力「${capability}」：${reasons || '无候选 provider'}`, { rejections: resolved.rejections })
  }

  let envelope: ProviderEnvelope
  try {
    envelope = await service.invoke(
      { binding: resolved.binding, input: gated.input, context: args.context },
      { agent: exec.agent, signal: exec.signal },
    )
  } catch (error) {
    return fail('PROVIDER_CALL_ERROR', error instanceof Error ? error.message : String(error))
  }
  const result = summarizeEnvelope(envelope, capability)
  if (datasetInfo !== undefined) {
    result.dataset = datasetInfo.id
    result.datasetVersion = datasetInfo.version
    result.signature = datasetInfo.signature
    // Fetch gate (tiered): source/caliber are the identity+caliber contract —
    // a successful envelope without them is a data-quality FAILURE (reviews
    // must never cite unprovable numbers). unit is provider-dependent: the
    // zyt series envelope does not carry one, so a missing unit degrades to a
    // warning; same for an empty series payload (nothing to cite, but not a
    // transport failure).
    if (envelope.ok) {
      const warnings = [...(result.warnings ?? [])]
      const provenanceError = validateDatasetProvenance(datasetInfo.definition, result.provenance)
      if (provenanceError !== undefined) {
        return fail('DATA_QUALITY_INVALID', provenanceError.correction, {
          missing: provenanceError.details?.missing,
          dataset: datasetInfo.id,
          signature: datasetInfo.signature,
          provenance: result.provenance,
        })
      }
      const unitValue = result.provenance?.['unit']
      if (unitValue === undefined || unitValue === null || unitValue === '') {
        warnings.push({ code: 'provenance.unit.missing', severity: 'warning', message: `数据集「${datasetInfo.id}」返回缺少单位（unit）；引用数值前必须先确认单位` })
      }
      if (isRecord(result.data) && Array.isArray(result.data['series']) && result.data['series'].length === 0) {
        warnings.push({ code: 'dataset.empty-series', severity: 'warning', message: `数据集「${datasetInfo.id}」返回空序列（series=[]）；该城市×指标可能无覆盖，禁止据空序列下结论` })
      }
      result.warnings = warnings
    }
  }
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
      dataset: { type: 'string', description: `已注册数据集 id（首选入口；自动映射版本钉扎的 capability 并校验口径）：${ZHIJIAN_DATASETS.map(definition => definition.dataset).join('、')}。` },
      version: { type: 'string', description: '数据集契约版本（可选；缺省取注册表当前版本）。' },
      capability: { type: 'string', description: 'provider 能力 id（兼容入口；与 dataset 同传时必须与映射一致）。如 financial.stock.snapshot、realestate.indicators.timeseries、realestate.listing.search。' },
      input: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: '该能力契约的参数 JSON 对象（如 {"windcode":"600519.SH"} / {"city":"杭州","period":"2025-01","metric":"成交量"}）。',
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
