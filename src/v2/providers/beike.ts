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
 * ⚠ The binary (`beike` v0.2.24, macOS arm64) is **not executable on this
 * Linux host**; the command surface was recovered by static analysis
 * (strings/symbols). Operation→tool-name/argv mappings and the live response
 * schema/caliber are therefore **unverified** — marked as such in the manifest
 * caveats and compensated by fail-closed invocation when the binary or key is
 * unavailable.
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
 *  Operation tables (UNVERIFIED — static-analysis derived).
 * ------------------------------------------------------------------ */

/** Read operations (bind the read-only MCP HTTP transport). */
export const BEIKE_READ_OPERATIONS: Readonly<Record<string, string>> = {
  'realestate.listing.search': 'buy.search',
  'realestate.listing.detail': 'buy.detail',
  'realestate.deal.search': 'buy.sold',
  'realestate.resblock.profile': 'buy.resblock',
  'realestate.market.trend': 'buy.market',
  'realestate.rent.search': 'rent.search',
  'realestate.rent.detail': 'rent.detail',
  'realestate.policy.search': 'policy.search',
  'realestate.geo.code': 'map.geo',
}

/** Write / sensitive operations (bind the write transport; approval required). */
export const BEIKE_WRITE_OPERATIONS: Readonly<Record<string, string>> = {
  'realestate.rent.appoint': 'rent.appoint',
  'realestate.sell.list': 'sell.list',
  'realestate.agent.contact': 'agent.contact',
  'realestate.decor.contact': 'decor.contact',
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
  '二进制为 macOS arm64，本机 Linux 不可执行；命令面/工具名来自静态分析，响应 schema 与口径待实测',
  '无稳定业务错误码（clap 参数错 exit 2，panic 101）；以 --json 输出与 stderr 判定成败，retry 由调用方决定',
  '写/敏感操作（rent appoint / sell / agent contact / decor contact）readOnly=false，必须审批',
  '统计口径（成交/均价）由服务端定义，待实测确认后写入 DataGate',
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
  /** Provider manifest version (default `0.2.24`). */
  readonly version?: string
  /** Per-call timeout in milliseconds (default 60_000). */
  readonly timeoutMs?: number
}

/**
 * Build the beike manifest. Reads bind the read-only `mcp-http` transport;
 * writes bind the dedicated `mcp-http-write` transport (same endpoint,
 * `readOnly: false`) so the registry's write gate and approval flow apply.
 * An optional `cli` transport is added when a binary is configured.
 */
export function buildBeikeManifest(options: BeikeManifestOptions = {}): ToolProviderManifest {
  const { baseUrl = 'https://building.ke.com/mcp', cliCommand, preferCli = false, version = '0.2.24', timeoutMs = 60_000 } = options
  const auth = { credentialRef: 'BEIKE_MCP_API_KEY', source: 'file', hint: '~/.beike/BEIKE_MCP_API_KEY' } as const
  const transports: ToolTransport[] = [
    { kind: 'mcp-http', id: 'mcp-http', endpoint: baseUrl, timeoutMs, readOnly: true, auth },
    { kind: 'mcp-http', id: 'mcp-http-write', endpoint: baseUrl, timeoutMs, readOnly: false, auth },
  ]
  if (cliCommand !== undefined && cliCommand !== '') {
    transports.push({
      kind: 'local-cli',
      id: 'cli',
      command: cliCommand,
      args: ['--json'],
      timeoutMs,
      readOnly: true,
      auth: { credentialRef: 'BEIKE_MCP_API_KEY', source: 'env' },
    })
  }
  const readBind = preferCli && cliCommand !== undefined && cliCommand !== '' ? 'cli' : 'mcp-http'
  const capabilities: ToolCapability[] = [
    ...Object.entries(BEIKE_READ_OPERATIONS).map(([capability, tool]) => ({
      capability,
      operation: `beike.${tool}`,
      transportId: readBind,
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

/**
 * Build the MCP `tools/call` request for one operation. The tool name is the
 * static-analysis-derived dotted id (e.g. `buy.search`) — **unverified**
 * against the live proxy; the arguments are passed through verbatim.
 */
export function beikeMCPCallParams(operation: string, input: unknown): BeikeMCPCall {
  const tool = BEIKE_OPERATION_BY_OPERATION[operation] ?? BEIKE_OPERATION_TOOLS[operation]
  if (tool === undefined) throw new Error(`unknown beike operation: ${operation}`)
  return { method: 'tools/call', params: { name: tool, arguments: isRecord(input) ? input : {} } }
}

/**
 * Build the one-shot CLI argv for one operation (`buy search …`, `rent
 * search …`), appending input keys as `--key value` flags. **Unverified**
 * against the binary — compensated by fail-closed invocation.
 */
export function beikeCliArgv(operation: string, input: unknown): string[] {
  const tool = BEIKE_OPERATION_BY_OPERATION[operation] ?? BEIKE_OPERATION_TOOLS[operation]
  if (tool === undefined) throw new Error(`unknown beike operation: ${operation}`)
  const parts = tool.split('.')
  const argv = [parts[0]!, ...(parts[1] !== undefined ? [parts[1]] : [])]
  if (isRecord(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value !== '') argv.push(`--${key}`, value)
    }
  }
  return argv
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
  return normalizeBeikeEnvelope({ exitCode: raw.exitCode, json, stderr: raw.stderr } as BeikeRawResult, options)
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
  if (raw.status >= 400) {
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
