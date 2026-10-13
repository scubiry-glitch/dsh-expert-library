/**
 * beike (贝壳) provider — pure declarations, request planning and output
 * normalization (Phase 2 `provider-beike`; NEXT-GENERATION-ARCHITECTURE.md
 * §5.3).
 *
 * This module is JSON-safe and performs **no I/O**. It builds the manifest
 * (MCP HTTP transport over `building.ke.com/mcp`, optional local CLI), plans
 * MCP `tools/call` params or CLI argv for each operation, and normalizes raw
 * MCP HTTP / CLI output through the compensated error model of
 * {@link normalizeBeikeEnvelope}: no stable business error codes in the
 * binary, so failures carry a stable fallback code and **never** an invented
 * retry directive.
 *
 * The Linux beike 0.2.26 CLI supports a subset of the MCP read surface.
 * Unsupported capabilities remain on MCP HTTP even when CLI is preferred.
 * @module dsh-expert-library/v2/providers/beike
 */

import {
  failEnvelope,
  normalizeBeikeEnvelope,
  type BeikeNormalizeOptions,
  type BeikeRawResult,
  type ProviderEnvelope,
  type ProvenanceInput,
} from '../provider-runtime.ts'
import type { ToolCapability, ToolProviderManifest, ToolTransport } from '../types.ts'
import { SCHEMA_VERSION } from '../types.ts'

/* ------------------------------------------------------------------ *
 *  Operation tables.
 * ------------------------------------------------------------------ */

/** Read operations (bind the read-only MCP HTTP transport). */
export const BEIKE_READ_OPERATIONS: Readonly<Record<string, string>> = {
  'realestate.listing.search': 'house_search',
  'realestate.newhouse.search': 'newhouse_search',
  'realestate.resblock.profile': 'resblock_search',
  'realestate.plate.search': 'plate_search',
  'realestate.rent.search': 'rent_house_search',
  'realestate.policy.search': 'policy_search',
  'realestate.decor.search': 'decorate_search',
  'realestate.rank.house': 'house_rank_search',
  'realestate.rank.resblock': 'resblock_rank_search',
  'realestate.agent.search': 'agent_search',
  'realestate.store.search': 'store_search',
  'realestate.entity.resolve': 'entity_resolution',
  'realestate.entity.detail': 'entity_detail',
  'realestate.entity.material': 'entity_material',
  'realestate.geo.code': 'entity_resolution',
  'realestate.decor.store.search': 'decor_store_search',
  'realestate.decor.price.query': 'decor_price_query',
}

/**
 * Write / sensitive operations (bind the write transport; approval
 * required). The live MCP surface's only contact/sensitive tool is
 * `wecom_add_contact_qrcode`（添加经纪人企业微信，涉个人信息）— the
 * appoint/contact capabilities all gate through it.
 */
export const BEIKE_WRITE_OPERATIONS: Readonly<Record<string, string>> = {
  'realestate.rent.appoint': 'wecom_add_contact_qrcode',
  'realestate.agent.contact': 'wecom_add_contact_qrcode',
  'realestate.decor.contact': 'wecom_add_contact_qrcode',
}

/** Every operation this provider serves. */
export const BEIKE_OPERATION_TOOLS: Readonly<Record<string, string>> = {
  ...BEIKE_READ_OPERATIONS,
  ...BEIKE_WRITE_OPERATIONS,
}

/**
 * Operation id (e.g. `beike.buy.search`) → tool id (e.g. `buy.search`),
 * derived from the capability tables; the invoker receives operation ids.
 */
export const BEIKE_OPERATION_BY_OPERATION: Readonly<Record<string, string>> = Object.fromEntries(
  [...Object.entries(BEIKE_READ_OPERATIONS), ...Object.entries(BEIKE_WRITE_OPERATIONS)]
    .map(([, tool]) => [`beike.${tool}`, tool] as const),
)

const BEIKE_CAVEATS: readonly string[] = [
  '【实测 2026-08-22】MCP 端点 building.ke.com/mcp（serverInfo 布丁MCP服务 3.4.6，protocolVersion 2025-03-26），Authorization: Bearer 认证，17 个工具枚举核对；工具名与 CLI 静态分析推导不同，以本表实测名为准',
  '【实测 2026-10-08】Linux beike 0.2.26 CLI 支持 buy/rent/policy search；仅这些已映射的只读能力在 preferCli 时走 CLI，其余继续走 MCP HTTP',
  '无稳定业务错误码（clap 参数错 exit 2，panic 101）；以 --json 输出与 stderr 判定成败，retry 由调用方决定',
  '写/敏感操作（rent appoint / agent contact / decor contact → wecom_add_contact_qrcode，涉个人信息）readOnly=false，必须审批',
  '统计口径（成交/均价）由服务端定义；逐响应 schema 已实测可解析，DataGate 口径规则随业务使用固化',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ------------------------------------------------------------------ *
 *  Manifest.
 * ------------------------------------------------------------------ */

/** Options accepted by {@link buildBeikeManifest}. */
export interface BeikeManifestOptions {
  /** MCP endpoint (default `https://building.ke.com/mcp`). */
  readonly baseUrl?: string
  /**
   * Absolute path or command name of a `beike` binary. When set, a second
   * `local-cli` transport (`cli`) is declared; read capabilities bind to it
   * when `preferCli` is true, else to `mcp-http`.
   */
  readonly cliCommand?: string
  /** Bind read capabilities to the CLI transport instead of MCP HTTP. */
  readonly preferCli?: boolean
  /** Provider manifest version (default `0.2.26`). */
  readonly version?: string
  /** Per-call timeout in milliseconds (default 60_000). */
  readonly timeoutMs?: number
}

/**
 * Build the beike manifest. CLI-supported reads may bind `cli`; other reads
 * bind the read-only `mcp-http` transport;
 * writes bind the dedicated `mcp-http-write` transport (same endpoint,
 * `readOnly: false`) so the registry's write gate and approval flow apply.
 * An optional `cli` transport is added when a binary is configured.
 */
export function buildBeikeManifest(options: BeikeManifestOptions = {}): ToolProviderManifest {
  const { baseUrl = 'https://building.ke.com/mcp', cliCommand, preferCli = false, version = '0.2.26', timeoutMs = 60_000 } = options
  const auth = { credentialRef: 'BEIKE_MCP_API_KEY', source: 'file', hint: '~/.beike/BEIKE_MCP_API_KEY' } as const
  // 服务端按 initialize.clientInfo 识别客户端版本（旧身份 dsh-expert-library/0.1.0
  // 会被判「未检测到 CLI 版本」拒收），故声明为 CLI 同款身份。修复 2026-09-28。
  const clientInfo = { name: 'beike-mcp-proxy', version: '0.2.26' } as const
  const transports: ToolTransport[] = [
    { kind: 'mcp-http', id: 'mcp-http', endpoint: baseUrl, timeoutMs, readOnly: true, auth, clientInfo },
    { kind: 'mcp-http', id: 'mcp-http-write', endpoint: baseUrl, timeoutMs, readOnly: false, auth, clientInfo },
  ]
  if (cliCommand !== undefined && cliCommand !== '') {
    transports.push({
      kind: 'local-cli',
      id: 'cli',
      command: cliCommand,
      timeoutMs,
      readOnly: true,
      auth,
    })
  }
  const capabilities: ToolCapability[] = [
    ...Object.entries(BEIKE_READ_OPERATIONS).map(([capability, tool]) => ({
      capability,
      operation: `beike.${tool}`,
      transportId: preferCli && cliCommand && CLI_READ_TOOLS.has(tool) ? 'cli' : 'mcp-http',
      caliber: '贝壳线上实时数据（口径由服务端定义，待实测）',
      freshness: 'realtime' as const,
    })),
    ...Object.entries(BEIKE_WRITE_OPERATIONS).map(([capability, tool]) => ({
      capability,
      operation: `beike.${tool}`,
      transportId: 'mcp-http-write',
      caliber: '贝壳线上实时数据（口径由服务端定义，待实测）',
      freshness: 'realtime' as const,
    })),
  ]
  return {
    id: 'beike',
    version,
    schemaVersion: SCHEMA_VERSION,
    capabilities,
    transports,
    caveats: BEIKE_CAVEATS,
  }
}

/* ------------------------------------------------------------------ *
 *  Request planning.
 * ------------------------------------------------------------------ */

/** MCP `tools/call` input the Host mcp-http runner executes. */
export interface BeikeMCPCall {
  /** JSON-RPC method (always `tools/call`). */
  readonly method: 'tools/call'
  /** JSON-RPC params: `{ name, arguments }`. */
  readonly params: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
}

/** Parameter errors are caller-correctable and must not become transport retries. */
export class BeikeInputError extends Error {}

/** Map dataset field names to the live MCP schema (verified 2026-10-06). */
export function beikeMCPCallParams(operation: string, input: unknown): BeikeMCPCall {
  const tool = BEIKE_OPERATION_BY_OPERATION[operation] ?? BEIKE_OPERATION_TOOLS[operation]
  if (tool === undefined) throw new Error(`unknown beike operation: ${operation}`)
  if (tool !== 'rent_house_search' && tool !== 'policy_search')
    return { method: 'tools/call', params: { name: tool, arguments: isRecord(input) ? input : {} } }
  if (!isRecord(input)) throw new BeikeInputError('input must be an object')
  const fields = new Set(['city', 'city_name', 'query', ...(tool === 'policy_search' ? ['topic'] : ['period', 'business_types'])])
  const unknown = Object.keys(input).filter(key => !fields.has(key))
  if (unknown.length) throw new BeikeInputError(`Unsupported ${tool} fields: ${unknown.join(', ')}; express search constraints in query`)
  const text = (key: string): string | undefined => {
    const value = input[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) throw new BeikeInputError(`${key} must be a nonempty string`)
    return value.trim()
  }
  const city = text('city'), nativeCity = text('city_name')
  if (city && nativeCity && city !== nativeCity) throw new BeikeInputError('city and city_name conflict')
  const cityName = nativeCity ?? city
  if (!cityName) throw new BeikeInputError('city or city_name is required')
  const query = text('query'), topic = text('topic')
  text('period') // A research period is metadata, never a historical filter.
  if (tool === 'policy_search' && !query && !topic) throw new BeikeInputError('topic or query is required')
  const args: Record<string, unknown> = { city_name: cityName,
    query: tool === 'policy_search' ? [topic, query].filter((value, i, all) => value && all.indexOf(value) === i).join('；')
      : query ?? `${cityName}当前在租房源` }
  if (input.business_types !== undefined) {
    if (!Array.isArray(input.business_types) || input.business_types.some(value => value !== '省心租' && value !== '普租'))
      throw new BeikeInputError('business_types must be an array containing only 省心租 / 普租')
    args.business_types = input.business_types
  }
  return { method: 'tools/call', params: { name: tool, arguments: args } }
}

/**
 * Build argv for the verified Linux CLI read subset. `--json` belongs after
 * the subcommand; MCP tool names are never passed as CLI subcommands.
 */
const CLI_READ_TOOLS = new Set(['house_search', 'rent_house_search', 'policy_search'])

export function beikeCliArgv(operation: string, input: unknown): string[] {
  const tool = BEIKE_OPERATION_BY_OPERATION[operation] ?? BEIKE_OPERATION_TOOLS[operation]
  if (tool === undefined) throw new Error(`unknown beike operation: ${operation}`)
  if (!CLI_READ_TOOLS.has(tool)) throw new BeikeInputError(`CLI does not support ${tool}`)
  if (!isRecord(input)) throw new BeikeInputError('input must be an object')
  const allowed = new Set(['city', 'city_name', 'query', ...(tool === 'policy_search' ? ['topic'] : tool === 'rent_house_search' ? ['period'] : [])])
  const unknown = Object.keys(input).filter(key => !allowed.has(key))
  if (unknown.length) throw new BeikeInputError(`Unsupported ${tool} CLI fields: ${unknown.join(', ')}`)
  const value = (key: string): string | undefined => {
    const raw = input[key]
    if (raw === undefined) return undefined
    if (typeof raw !== 'string' || !raw.trim()) throw new BeikeInputError(`${key} must be a nonempty string`)
    return raw.trim()
  }
  const city = value('city'), nativeCity = value('city_name')
  if (city && nativeCity && city !== nativeCity) throw new BeikeInputError('city and city_name conflict')
  const cityName = nativeCity ?? city
  if (!cityName) throw new BeikeInputError('city or city_name is required')
  const query = value('query')
  value('period') // Research metadata, never a historical filter.
  if (tool === 'policy_search') {
    const topic = value('topic')
    if (!topic && !query) throw new BeikeInputError('topic or query is required')
    return ['policy', 'search', '--city', cityName, '--query', [topic, query].filter((part, i, parts) => part && parts.indexOf(part) === i).join('；'), '--json']
  }
  if (tool === 'rent_house_search') return ['rent', 'search', '--city', cityName, '--query', query ?? `${cityName}当前在租房源`, '--json']
  return ['buy', 'search', '--city', cityName, '--query', query ?? `${cityName}二手房`, '--house-type', 'second', '--json']
}

/* ------------------------------------------------------------------ *
 *  Output normalization (compensated error model, §5.3).
 * ------------------------------------------------------------------ */

/** Raw result of one beike CLI invocation (`--json` on stdout). */
export interface BeikeCliResult {
  /** Process exit code (0 success; clap param errors → 2; panic → 101). */
  readonly exitCode: number
  /** stdout text — the `--json` payload, when produced. */
  readonly stdout: string
  /** Raw stderr (anyhow error chain / clap usage). */
  readonly stderr?: string
}

/** Raw result of one beike MCP HTTP call. */
export interface BeikeMCPHttpResult {
  readonly status: number
  /** JSON-RPC response payload JSON (result or error object). */
  readonly body: string
}

const BEIKE_BODY_LIMIT = 2000

function provenanceOf(options: BeikeNormalizeOptions): ProvenanceInput {
  return {
    provider: options.provider ?? 'beike',
    operation: options.operation,
    transportId: options.transportId,
    fetchedAt: options.fetchedAt,
    source: options.source,
    caliber: options.caliber,
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Normalize raw CLI output (parsed `--json` stdout) through
 * {@link normalizeBeikeEnvelope} — the compensated error model: stable
 * fallback code, no invented retry, bounded stderr preserved for audit.
 */
export function normalizeBeikeCliOutput(raw: BeikeCliResult, options: BeikeNormalizeOptions): ProviderEnvelope {
  let json: unknown
  try {
    json = JSON.parse(raw.stdout)
  } catch {
    json = undefined
  }
  const result = normalizeBeikeEnvelope({ exitCode: raw.exitCode, json, stderr: raw.stderr } as BeikeRawResult, options)
  if (!result.ok || !isRecord(result.data) || typeof result.data['data'] !== 'string') return result
  const text = result.data['data'] as string
  const entries: Record<string, unknown>[] = []
  for (const match of text.matchAll(/<(\d{8,})>\s*(\{[\s\S]*?\})\s*<\/\1>/g)) {
    try {
      const entity: unknown = JSON.parse(match[2]!)
      if (!isRecord(entity)) continue
      const summary = isRecord(entity['摘要信息']) ? entity['摘要信息'] : entity
      entries.push({ id: match[1], ...summary })
    } catch { /* Keep the raw response if one entity is malformed. */ }
  }
  if (!entries.length) return result
  return { ...result, data: { ...result.data, data: { list: entries, text } } }
}

/**
 * Normalize a raw MCP HTTP JSON-RPC response. HTTP ≥400 → `BEIKE_HTTP_ERROR`
 * (`never`, caller decides). A JSON-RPC `error` member → failure with the
 * payload error code/message preserved. A `result` with a text content
 * (`content[0].text`) is unwrapped into the inner JSON payload; otherwise the
 * whole result object is kept — in both cases the payload flows through
 * {@link normalizeBeikeEnvelope} so `unit`/caliber metadata survives.
 */
export function normalizeBeikeMCPHttpOutput(raw: BeikeMCPHttpResult, options: BeikeNormalizeOptions): ProviderEnvelope {
  if (raw.status < 200 || raw.status >= 300) {
    return failEnvelope({
      code: 'BEIKE_HTTP_ERROR',
      retry: 'never',
      details: { status: raw.status, body: raw.body.slice(0, BEIKE_BODY_LIMIT) },
    }, provenanceOf(options))
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw.body)
  } catch {
    return failEnvelope({
      code: 'BEIKE_INVALID_MCP_PAYLOAD',
      retry: 'never',
      correction: 'beike MCP 响应不是 JSON',
      details: { body: raw.body.slice(0, BEIKE_BODY_LIMIT) },
    }, provenanceOf(options))
  }
  if (!isRecord(payload)) {
    return failEnvelope({ code: 'BEIKE_INVALID_MCP_PAYLOAD', retry: 'never' }, provenanceOf(options))
  }
  if (payload['error'] !== undefined) {
    const err = isRecord(payload['error']) ? payload['error'] : undefined
    return failEnvelope({
      code: stringOrUndefined(err?.['code']) ?? 'BEIKE_MCP_ERROR',
      retry: 'never',
      ...(stringOrUndefined(err?.['message']) === undefined ? {} : { correction: err!['message'] as string }),
      details: { error: payload['error'] },
    }, provenanceOf(options))
  }
  const result = payload['result']
  // MCP tool failures are carried inside a successful JSON-RPC/HTTP reply.
  // Check the protocol flag before discarding the content wrapper.
  if (isRecord(result) && result['isError'] === true) {
    const response = JSON.stringify(result).slice(0, BEIKE_BODY_LIMIT)
    const messages = Array.isArray(result['content'])
      ? result['content'].flatMap(item => isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string' ? [item['text']] : [])
      : []
    return failEnvelope({
      code: 'BEIKE_MCP_TOOL_ERROR',
      retry: 'never',
      ...(messages.length === 0 ? {} : { correction: messages.join('\n').slice(0, BEIKE_BODY_LIMIT) }),
      details: { isError: true, response },
    }, provenanceOf(options))
  }
  let json: unknown = result
  if (isRecord(result) && Array.isArray(result['content'])) {
    const textItem = result['content'].find(item => isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string')
    const text = isRecord(textItem) ? textItem['text'] as string : undefined
    if (text !== undefined) {
      try {
        json = JSON.parse(text)
      } catch {
        json = text
      }
    }
  }
  return normalizeBeikeEnvelope({ exitCode: 0, json, stderr: undefined } as BeikeRawResult, options)
}
