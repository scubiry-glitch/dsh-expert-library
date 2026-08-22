/**
 * Wind provider — pure declarations, request planning and CLI-output
 * normalization (Phase 2 `provider-wind`; NEXT-GENERATION-ARCHITECTURE.md §5.1).
 *
 * This module is JSON-safe and performs **no I/O**: it only builds the
 * `ToolProviderManifest`, plans the exact `node <cli.mjs> call …` argv for an
 * operation, and maps a raw Wind CLI stdout/exit-code pair into a
 * {@link ProviderEnvelope}. The Host wires the declared `local-cli` transport
 * to its injected spawn runner.
 *
 * Contract notes grounded in the installed skill (`wind-mcp-skill`):
 * - The CLI is `node <skillRoot>/scripts/cli.mjs`; success (exit 0) prints the
 *   MCP double-layer envelope (`content[0].text` = normalized inner JSON +
 *   `cli_meta {schema_version, server_type, tool_name, completeness, tables,
 *   warnings}`); failure prints `{ok:false, code, message}` with a non-zero
 *   exit (USAGE_ERROR may exit 0 with the same envelope).
 * - `cli_meta.completeness` is currently `'unknown' | 'not_asserted'` rather
 *   than `'complete'` — {@link normalizeWindCliOutput} normalizes it so the
 *   shared runtime does not emit a warning on every successful call.
 * - The provider's own retry instruction is authoritative: only explicit codes
 *   (`RATE_LIMIT_ERROR`, `NETWORK_ERROR`) map to `backoff`; everything else is
 *   `never` (no invented retries). `{ok:false,code,message}` is the current
 *   drift from the §5.1 doc shape (`details/retry/circuit_breaker/…`) and is
 *   compensated here.
 * @module dsh-expert-library/v2/providers/wind
 */

import {
  failEnvelope,
  okEnvelope,
  normalizeWindEnvelope,
  type ProviderEnvelope,
  type ProvenanceInput,
  type ProviderWarning,
  type RetryDirective,
  type WindNormalizeOptions,
} from '../provider-runtime.ts'
import type { ToolCapability, ToolProviderManifest } from '../types.ts'
import { SCHEMA_VERSION } from '../types.ts'

/* ------------------------------------------------------------------ *
 *  Manifest (§5.1): one local-cli transport over the installed skill.
 * ------------------------------------------------------------------ */

/** Options accepted by {@link buildWindManifest}. */
export interface WindManifestOptions {
  /** Absolute path to the installed skill CLI (`scripts/cli.mjs`). */
  readonly cliPath: string
  /** Provider manifest version (default `1.0.0`). */
  readonly version?: string
  /** Per-call timeout in milliseconds (default 120_000). */
  readonly timeoutMs?: number
}

/** Capability surface: capability → (server_type, tool_name) route. */
export const WIND_OPERATION_ROUTES: Readonly<Record<string, { readonly serverType: string; readonly toolName: string }>> = {
  'wind.discovery.list-tools': { serverType: 'stock_data', toolName: '' },
  'financial.stock.snapshot': { serverType: 'stock_data', toolName: 'get_stock_price_indicators' },
  'financial.stock.quote': { serverType: 'stock_data', toolName: 'get_stock_quote' },
  'financial.stock.kline': { serverType: 'stock_data', toolName: 'get_stock_kline' },
  'financial.stock.screen': { serverType: 'stock_data', toolName: 'search_stocks' },
  'financial.fund.snapshot': { serverType: 'fund_data', toolName: 'get_fund_price_indicators' },
  'financial.fund.screen': { serverType: 'fund_data', toolName: 'search_funds' },
  'financial.index.snapshot': { serverType: 'index_data', toolName: 'get_index_price_indicators' },
  'financial.index.quote': { serverType: 'index_data', toolName: 'get_index_quote' },
  'financial.bond.valuation': { serverType: 'bond_data', toolName: 'get_bond_market_data' },
  'financial.macro.query': { serverType: 'economic_data', toolName: 'natural_language_get_edb_data' },
  'financial.docs.search': { serverType: 'financial_docs', toolName: 'get_financial_news' },
}

/** Freshness per capability for the resolver's `minFreshness` gate. */
const WIND_FRESHNESS: Readonly<Record<string, 'realtime' | 'daily' | 'static'>> = {
  'wind.discovery.list-tools': 'static',
  'financial.stock.snapshot': 'realtime',
  'financial.stock.quote': 'realtime',
  'financial.stock.kline': 'realtime',
  'financial.stock.screen': 'realtime',
  'financial.fund.snapshot': 'realtime',
  'financial.fund.screen': 'realtime',
  'financial.index.snapshot': 'realtime',
  'financial.index.quote': 'realtime',
  'financial.bond.valuation': 'daily',
  'financial.macro.query': 'daily',
  'financial.docs.search': 'daily',
}

/**
 * Build the Wind provider manifest: a single `local-cli` transport running
 * `node <cliPath>` from the skill directory, with the API key resolved by the
 * credential layer (`~/.wind-aifinmarket/config` > skill config > env).
 * The declared command/args are fixed constants — the adapter appends
 * operation-specific `call <server_type> <tool_name> <params>` args.
 */
export function buildWindManifest(options: WindManifestOptions): ToolProviderManifest {
  const { cliPath, version = '1.0.0', timeoutMs = 120_000 } = options
  const capabilities: ToolCapability[] = Object.entries(WIND_OPERATION_ROUTES).map(([capability, route]) => ({
    capability,
    operation: capability,
    transportId: 'cli',
    caliber: route.toolName !== '' ? 'wind 实时行情口径（以返回体 data.unit/meta.unit 为准，null=缺失禁当 0）' : undefined,
    freshness: WIND_FRESHNESS[capability] ?? 'daily',
  }))
  return {
    id: 'wind',
    version,
    schemaVersion: SCHEMA_VERSION,
    capabilities,
    transports: [
      {
        kind: 'local-cli',
        id: 'cli',
        command: 'node',
        args: [cliPath],
        workingDirectory: dirnameOf(cliPath),
        timeoutMs,
        readOnly: true,
        auth: { credentialRef: 'WIND_API_KEY', source: 'file', hint: '~/.wind-aifinmarket/config' },
      },
    ],
    discovery: { operation: 'wind.discovery.list-tools', refresh: 'daily' },
    caveats: [
      'null=缺失，禁当 0',
      '价格指标单次 ≤50 码，默认串行、并发 ≤10',
      '错误信封为 {ok:false,code,message}；RATE_LIMIT_ERROR/NETWORK_ERROR 可退避重试，其余禁重试',
      'list-tools 返回官方 inputSchema，作为 discovery，不复制 39 套参数 schema',
    ],
  }
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return path
  return path.slice(0, idx)
}

/* ------------------------------------------------------------------ *
 *  Request planning — pure argv builder for the Host spawn runner.
 * ------------------------------------------------------------------ */

/** Spawn input the Host local-cli runner executes for one operation. */
export interface WindCallPlan {
  /** Args appended after the manifest's static `args` (`call …` or `list-tools …`). */
  readonly args: string[]
  /** Extra env (the API key under `WIND_API_KEY`) — never logged. */
  readonly env?: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Build the CLI argv for one Wind operation from a JSON-safe input.
 * `wind.discovery.list-tools` plans `list-tools <server_type>` (input may
 * carry `serverType`; defaults to `stock_data`); every other operation plans
 * `call <server_type> <tool_name> '<params_json>'` with the input passed
 * through verbatim (inline JSON, the skill's POSIX convention).
 */
export function windCallPlan(operation: string, input: unknown): WindCallPlan {
  const route = WIND_OPERATION_ROUTES[operation]
  if (route === undefined) {
    throw new Error(`unknown wind operation: ${operation}`)
  }
  if (operation === 'wind.discovery.list-tools') {
    const serverType = isRecord(input) ? stringOf(input['serverType']) ?? route.serverType : route.serverType
    return { args: ['list-tools', serverType] }
  }
  const params = isRecord(input) ? input : {}
  return { args: ['call', route.serverType, route.toolName, JSON.stringify(params)] }
}

/* ------------------------------------------------------------------ *
 *  CLI-output normalization — compensates the §5.1 drift.
 * ------------------------------------------------------------------ */

/** Raw result of one Wind CLI invocation (Host spawn runner output). */
export interface WindCliResult {
  /** Process exit code (0 success; the CLI also exits 0 for USAGE_ERROR). */
  readonly exitCode: number
  /** stdout text — the JSON envelope the CLI always writes. */
  readonly stdout: string
  /** Bounded stderr, when any (audit only). */
  readonly stderr?: string
}

const WIND_STDERR_LIMIT = 2000

/** Explicit Wind codes that map to a backoff retry directive. */
function windCodeRetry(code: string): RetryDirective {
  if (code === 'RATE_LIMIT_ERROR' || code === 'NETWORK_ERROR') return 'backoff'
  return 'never'
}

function provenanceOf(options: WindNormalizeOptions): ProvenanceInput {
  return {
    provider: options.provider ?? 'wind',
    operation: options.operation,
    transportId: options.transportId,
    fetchedAt: options.fetchedAt,
    source: options.source,
    caliber: options.caliber,
  }
}

/**
 * Normalize the raw Wind CLI output into a {@link ProviderEnvelope}, bridging
 * the current CLI contract to the shared runtime:
 *
 * - Success: the MCP double-layer envelope is delegated to
 *   {@link normalizeWindEnvelope} (inner `content[0].text` kept verbatim,
 *   `unit` mirrored into provenance), after normalizing
 *   `cli_meta.completeness: 'unknown'|'not_asserted'` to `'complete'` when the
 *   CLI reported no warnings (the runtime otherwise warns on every call).
 *   A payload without a text content (e.g. `list-tools` → `{server_type,
 *   tools}`) is returned as-is.
 * - Failure: `{ok:false, code, message}` is mapped to the runtime failure
 *   envelope — `message` becomes `correction` + `details.message`,
 *   `RATE_LIMIT_ERROR`/`NETWORK_ERROR` become `backoff`, everything else
 *   `never` (provider directive authoritative, never invented).
 * - Unparseable stdout → `WIND_INVALID_CLI_OUTPUT` (`never`).
 */
export function normalizeWindCliOutput(raw: WindCliResult, options: WindNormalizeOptions): ProviderEnvelope {
  const stderr = raw.stderr === undefined ? undefined : raw.stderr.slice(0, WIND_STDERR_LIMIT)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.stdout)
  } catch {
    return failEnvelope({
      code: 'WIND_INVALID_CLI_OUTPUT',
      retry: 'never',
      correction: 'wind CLI stdout 不是 JSON（进程崩溃或输出被截断）',
      details: { exitCode: raw.exitCode, stderr },
    }, provenanceOf(options))
  }
  if (!isRecord(parsed)) {
    return failEnvelope({
      code: 'WIND_INVALID_CLI_OUTPUT',
      retry: 'never',
      correction: 'wind CLI stdout 必须是 JSON 对象',
      details: { exitCode: raw.exitCode, stderr },
    }, provenanceOf(options))
  }
  let envelope: Record<string, unknown> = parsed

  const explicitFailure = envelope['ok'] === false || typeof envelope['code'] === 'string'
  if (raw.exitCode !== 0 || explicitFailure) {
    const code = typeof envelope['code'] === 'string' && envelope['code'] !== '' ? envelope['code'] : 'WIND_ERROR'
    const message = typeof envelope['message'] === 'string' && envelope['message'] !== '' ? envelope['message'] : undefined
    const warnings: ProviderWarning[] = []
    if (code === 'AUTH_ERROR') {
      warnings.push({ code: 'wind.auth', message: '认证失败，检查 API Key（全局配置 > skill 配置 > WIND_API_KEY）', severity: 'warning' })
    }
    return failEnvelope({
      code,
      retry: windCodeRetry(code),
      ...(message === undefined ? {} : { correction: message }),
      details: {
        ...(message === undefined ? {} : { message }),
        exitCode: raw.exitCode,
        ...(stderr === undefined ? {} : { stderr }),
      },
    }, provenanceOf(options), warnings)
  }

  // Success path: normalize cli_meta.completeness drift, then delegate.
  const meta = isRecord(envelope['cli_meta']) ? envelope['cli_meta'] as Record<string, unknown> : undefined
  if (meta !== undefined) {
    const completeness = meta['completeness']
    const hasWarnings = Array.isArray(meta['warnings']) && (meta['warnings'] as unknown[]).length > 0
    if (typeof completeness === 'string' && completeness !== 'complete' && !hasWarnings) {
      envelope = { ...envelope, cli_meta: { ...meta, completeness: 'complete' } }
    }
  }
  // `list-tools` style payloads carry no text content — return them verbatim.
  const content = envelope['content']
  const hasTextContent = Array.isArray(content) && content.some(item => isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string')
  if (!hasTextContent) {
    const warnings: ProviderWarning[] = []
    const metaWarnings = meta?.['warnings']
    if (Array.isArray(metaWarnings)) {
      for (const warning of metaWarnings) {
        if (typeof warning === 'string') warnings.push({ code: 'wind.cli-meta.warning', message: warning, severity: 'warning' })
      }
    }
    return okEnvelope(envelope, provenanceOf(options), warnings)
  }
  return normalizeWindEnvelope(envelope as Parameters<typeof normalizeWindEnvelope>[0], options)
}
