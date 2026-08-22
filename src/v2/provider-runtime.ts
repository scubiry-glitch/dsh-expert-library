/**
 * Phase 2 Provider Runtime — registry, capability resolution, envelopes.
 *
 * Implements `provider-runtime` from NEXT-GENERATION-ARCHITECTURE.md §12
 * (and §4.1/§4.5/§5): the L1 runtime core that the Phase 2 adapters
 * (`provider-wind`, `provider-zyt`, `provider-beike`, knowledge providers)
 * build on. Pure and JSON-safe — no I/O, no live objects; everything a
 * caller may persist or audit is a plain frozen record.
 *
 * Scope:
 * - {@link ProviderRegistry}: register / replace / unregister
 *   {@link ToolProviderManifest}s. Manifests are validated with the same
 *   strict pack validator as Domain Packs (`validateDomainPack`), indexed by
 *   capability, and every state change is appended to an immutable audit
 *   log. Registered manifests are deep-frozen copies — the registry owns its
 *   state and callers can never mutate it.
 * - {@link CapabilityResolver}: bind one required capability to a concrete
 *   `provider.operation + transport`, honoring the §4.1 intersection:
 *   task capability allowlist ∩ installed providers ∩ allowed providers ∩
 *   credential availability ∩ read-only policy ∩ data freshness. Every
 *   binding and every rejection carries a human-auditable reason and is
 *   frozen. Providers never back each other up implicitly — substitution
 *   happens only through explicitly declared `fallbacks` (§3.4
 *   `ToolPolicy.fallbacks`), and the actual hit is recorded in the binding
 *   reason, so Wind/zyt/beike can never silently swap (their separate
 *   identities are §5.3 conclusions).
 * - {@link ProviderEnvelope} with factories and the Wind / zyt / beike
 *   normalization adapters. The Wind adapter preserves the CLI's double-layer
 *   MCP envelope (`content[0].text` + `cli_meta`), its `unit` metadata, and
 *   its structured failure directives (`retry{allowed,mode,max_attempts}`,
 *   `circuit_breaker`, `correction`, `agent_action`) — the caller must obey
 *   the returned `retry` directive instead of a blanket "retry three times"
 *   (§5.1). The zyt adapter preserves exit-code semantics (0/1/2/3),
 *   `dataView` caliber (internal vs external-indexed) and units (§5.2). The
 *   beike adapter implements the §5.3 compensated error model: a stable
 *   fallback code and **no invented retry** (beike has no stable error codes;
 *   the caller decides), preserving caliber, stderr and any payload error.
 * - Executable invoke seam: {@link ProviderInvoker} adapters are **injected
 *   by the Host** and attached to registered providers; the registry
 *   re-validates a resolved binding before each call (staleness: provider
 *   removed / version replaced / operation or transport gone), rejects
 *   `readOnly: false` calls without an explicit `approved: true`, validates
 *   the returned envelope's provenance against the binding, and freezes +
 *   audits the result. This module never launches processes or opens sockets.
 * @module dsh-expert-library/v2/provider-runtime
 */

import { SCHEMA_VERSION, type PackDiagnostic, type ToolCapability, type ToolProviderManifest, type ToolTransport } from './types.ts'
import { validateDomainPack } from './validate.ts'

/* ------------------------------------------------------------------ *
 *  Envelope contract (§3.2) — runtime shape, JSON-safe, immutable.
 * ------------------------------------------------------------------ */

/** Retry directive attached to a provider error (§4.5, three-level retry). */
export type RetryDirective = 'never' | 'correct-input' | 'backoff'

/**
 * Provenance of one provider call — answers "这个数字从哪来"
 * (provider/operation/transport/caliber/fetchedAt, §4.5). `unit` and
 * `caliber` must survive normalization untouched.
 */
export interface ProviderProvenance {
  /** Provider id (e.g. `wind`, `zyt`). */
  readonly provider: string
  /** Operation id executed (e.g. `wind.stock.snapshot`). */
  readonly operation: string
  /** Transport id used (MCP/HTTP/CLI), when the adapter knows it. */
  readonly transportId?: string
  /** ISO timestamp of the fetch. */
  readonly fetchedAt: string
  /** Data source (endpoint, file, server type…). */
  readonly source?: string
  /** Data caliber note (e.g. `zyt.external(指数化)`, `贝壳成出口径`). */
  readonly caliber?: string
  /** Quantity unit of the payload (Wind `data.unit`, zyt `unit`); Wind ships
   * column→unit maps as objects — both shapes are mirrored verbatim. */
  readonly unit?: string | Readonly<Record<string, unknown>>
}

/** One non-fatal observation attached to an envelope. */
export interface ProviderWarning {
  readonly code: string
  readonly message: string
  readonly severity?: 'info' | 'warning'
}

/**
 * Normalized provider error. `retry` is the actionable directive the caller
 * must follow — `never` (abort), `correct-input` (fix parameters, no
 * backoff), `backoff` (transient, retry with delay). Raw provider fields
 * are preserved alongside for auditing, never discarded.
 */
export interface ProviderError {
  /** Stable machine code (Wind `code` like `USAGE_ERROR`, zyt `CITY_NOT_ALLOWED`…). */
  readonly code: string
  readonly retry: RetryDirective
  /** Human-readable fix hint (Wind `correction`). */
  readonly correction?: string
  /** Raw provider detail (Wind `details`, zyt `{message, httpStatus}`…) — audit-only. */
  readonly details?: unknown
  /** Wind `circuit_breaker` directive; when `tripped`, callers must abort remaining calls. */
  readonly circuitBreaker?: { readonly tripped: boolean; readonly scope?: string; readonly action?: string }
  /** Provider-granted retry budget (Wind `retry.max_attempts`). */
  readonly maxAttempts?: number
  /** Wind `agent_action` hint forwarded to the calling agent. */
  readonly agentAction?: string
  /** Raw retry mode string from the provider, when it does not map 1:1. */
  readonly retryMode?: string
}

/**
 * Every provider call returns this normalized envelope (§3.2).
 * Success: `ok: true` + `data`; failure: `ok: false` + `error`. `data` is
 * left exactly as the provider produced it (units, `null` markers and
 * columns are never coerced or flattened away).
 */
export interface ProviderEnvelope<T = unknown> {
  readonly ok: boolean
  readonly data?: T
  readonly provenance: ProviderProvenance
  readonly warnings: readonly ProviderWarning[]
  readonly error?: ProviderError
}

/** Builder input for {@link ProviderProvenance}; `fetchedAt` defaults to now. */
export interface ProvenanceInput {
  readonly provider: string
  readonly operation: string
  readonly transportId?: string
  readonly fetchedAt?: string
  readonly source?: string
  readonly caliber?: string
  /** Quantity unit (string or column→unit map), mirrored verbatim. */
  readonly unit?: string | Readonly<Record<string, unknown>>
}

function makeProvenance(input: ProvenanceInput): ProviderProvenance {
  return {
    provider: input.provider,
    operation: input.operation,
    ...(input.transportId === undefined ? {} : { transportId: input.transportId }),
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    source: input.source,
    // 显式 undefined 键会让 lossless JSON 校验失败（键存在但值无效）——
    // caliber/unit 缺省时整体不写键。
    ...(input.caliber === undefined ? {} : { caliber: input.caliber }),
    ...(input.unit === undefined ? {} : { unit: input.unit }),
  }
}

/** Freeze the envelope shell (provenance/warnings/error) but not the caller's data payload. */
function freezeEnvelope<T>(envelope: ProviderEnvelope<T>): ProviderEnvelope<T> {
  Object.freeze(envelope.provenance)
  Object.freeze(envelope.warnings)
  for (const warning of envelope.warnings) Object.freeze(warning)
  if (envelope.error !== undefined) Object.freeze(envelope.error)
  return Object.freeze(envelope)
}

/** Build a success envelope. */
export function okEnvelope<T>(data: T, provenance: ProvenanceInput, warnings: readonly ProviderWarning[] = []): ProviderEnvelope<T> {
  return freezeEnvelope({ ok: true, data, provenance: makeProvenance(provenance), warnings })
}

/** Build a failure envelope. */
export function failEnvelope(error: ProviderError, provenance: ProvenanceInput, warnings: readonly ProviderWarning[] = []): ProviderEnvelope<never> {
  return freezeEnvelope({ ok: false, error, provenance: makeProvenance(provenance), warnings })
}

/** Type guard: success envelopes produced by {@link okEnvelope} always carry `data`. */
export function isOk<T>(envelope: ProviderEnvelope<T>): envelope is ProviderEnvelope<T> & { ok: true; data: T } {
  return envelope.ok
}

/* ------------------------------------------------------------------ *
 *  Wind normalization (§5.1) — MCP double-layer envelope + error directives.
 * ------------------------------------------------------------------ */

/**
 * Raw outer envelope as the Wind CLI emits it: either the MCP success shape
 * (`content[0].text` holding the inner JSON + `cli_meta`) or the structured
 * error shape (`code`/`details`/`retry`/`circuit_breaker`…).
 */
export interface WindCliEnvelope {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  readonly cli_meta?: {
    readonly schema_version?: number | string
    readonly completeness?: string
    readonly tables?: readonly string[]
    readonly warnings?: readonly string[]
  }
  // Failure shape (exit code ≠ 0 or explicit error object).
  readonly code?: string
  readonly details?: unknown
  readonly retry?: { readonly allowed?: boolean; readonly mode?: string; readonly max_attempts?: number }
  readonly circuit_breaker?: { readonly tripped?: boolean; readonly scope?: string; readonly action?: string }
  readonly correction?: string
  readonly agent_action?: string
}

export interface WindNormalizeOptions {
  readonly provider?: string
  readonly operation: string
  readonly exitCode: number
  readonly transportId?: string
  readonly fetchedAt?: string
  readonly source?: string
  readonly caliber?: string
}

/** Map a Wind retry mode onto the closed {@link RetryDirective} union. */
function windRetryMode(mode: string | undefined): RetryDirective {
  switch (mode) {
    case 'backoff': return 'backoff'
    case 'correct-input':
    case 'fix-input':
    case 'correct_params':
      return 'correct-input'
    // No recognizable mode — never invent a directive. The raw string stays
    // in `error.retryMode` for audit (§5.1: the provider's instruction is
    // authoritative).
    default: return 'never'
  }
}

/** Build the normalized error from a Wind failure shape, preserving every directive. */
function windErrorFrom(raw: WindCliEnvelope): ProviderError {
  const breaker = raw.circuit_breaker
  const tripped = breaker?.tripped === true
  // The provider's own retry directive is authoritative (§5.1: no blanket
  // "retry three times"). A tripped circuit breaker aborts remaining calls;
  // only an explicit `retry.allowed: true` **with** a recognizable mode maps
  // to a retry directive. Missing, incomplete or unrecognized directives
  // (including `retry.allowed: true` without a mode) default to `never` —
  // backoff is never invented.
  let retry: RetryDirective = 'never'
  const retryInfo = raw.retry
  if (!tripped && retryInfo !== undefined && retryInfo.allowed === true && retryInfo.mode !== undefined) {
    retry = windRetryMode(retryInfo.mode)
  }
  return {
    code: raw.code ?? 'WIND_ERROR',
    retry,
    ...(raw.correction !== undefined ? { correction: raw.correction } : {}),
    ...(raw.details !== undefined ? { details: raw.details } : {}),
    ...(breaker !== undefined ? { circuitBreaker: { tripped, scope: breaker.scope, action: breaker.action } } : {}),
    ...(raw.retry?.max_attempts !== undefined ? { maxAttempts: raw.retry.max_attempts } : {}),
    ...(raw.agent_action !== undefined ? { agentAction: raw.agent_action } : {}),
    ...(raw.retry?.mode !== undefined ? { retryMode: raw.retry.mode } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize a raw Wind CLI result into a {@link ProviderEnvelope}.
 *
 * Success path: the MCP double-layer envelope is unwrapped (`content[0].text`
 * parsed as JSON), the inner payload is kept **as-is** — `columns`/`rows`
 * and `unit` are never flattened — and `unit` is mirrored into
 * `provenance.unit`. `cli_meta.warnings` / incomplete `completeness` become
 * warnings. Failure path: `code`, `retry` directive, `circuit_breaker`,
 * `correction` and `agent_action` are all preserved; `null` markers in rows
 * stay `null` (缺失 ≠ 0). The retry directive is never invented: only an
 * explicit `retry.allowed: true` plus a recognizable mode yields a retry,
 * anything else (including a missing directive) is `never`.
 */
export function normalizeWindEnvelope(raw: WindCliEnvelope, options: WindNormalizeOptions): ProviderEnvelope {
  const provenance: ProvenanceInput = {
    provider: options.provider ?? 'wind',
    operation: options.operation,
    transportId: options.transportId,
    fetchedAt: options.fetchedAt,
    source: options.source,
    caliber: options.caliber,
  }
  if (options.exitCode !== 0 || raw.code !== undefined) {
    const warnings: ProviderWarning[] = []
    if (raw.agent_action !== undefined) {
      warnings.push({ code: 'wind.agent-action', message: raw.agent_action, severity: 'info' })
    }
    return failEnvelope(windErrorFrom(raw), provenance, warnings)
  }

  const text = raw.content?.find(item => item.type === 'text')?.text
  if (text === undefined) {
    return failEnvelope({
      code: 'WIND_EMPTY_RESPONSE',
      retry: 'never',
      correction: 'provider returned no text payload in the MCP content array',
    }, provenance)
  }
  let inner: unknown
  try {
    inner = JSON.parse(text)
  } catch {
    return failEnvelope({
      code: 'WIND_INVALID_INNER_PAYLOAD',
      retry: 'never',
      correction: 'provider response did not match the MCP double-layer envelope (content[0].text must be JSON)',
    }, provenance)
  }
  if (!isRecord(inner)) {
    return failEnvelope({
      code: 'WIND_INVALID_INNER_PAYLOAD',
      retry: 'never',
      correction: 'provider inner payload must be a JSON object',
    }, provenance)
  }

  const warnings: ProviderWarning[] = []
  const meta = raw.cli_meta
  if (meta !== undefined) {
    for (const warning of meta.warnings ?? []) {
      warnings.push({ code: 'wind.cli-meta.warning', message: warning, severity: 'warning' })
    }
    if (meta.completeness !== undefined && meta.completeness !== 'complete') {
      warnings.push({ code: 'wind.cli-meta.completeness', message: `completeness ${meta.completeness}`, severity: 'warning' })
    }
  }
  const data = inner['data']
  // Wind ships `unit` either as a plain string (zyt-style) or as a
  // column→unit map ({"最新成交价":"元",…}); mirror both verbatim.
  const rawUnit = isRecord(data) ? data['unit'] : undefined
  const unit = (typeof rawUnit === 'string' && rawUnit !== '') || isRecord(rawUnit)
    ? rawUnit as string | Readonly<Record<string, unknown>>
    : undefined
  return okEnvelope(inner, { ...provenance, unit }, warnings)
}

/* ------------------------------------------------------------------ *
 *  zyt normalization (§5.2) — exit codes, dataView caliber, units.
 * ------------------------------------------------------------------ */

/**
 * Raw `--json` payload as the zyt CLI emits it (source contract): data
 * payloads (catalog responses carry `entries`), optional `error` object with
 * `httpStatus`, and `unit`/`dataView` metadata when the backend supplies it.
 */
export interface ZytCliPayload {
  readonly entries?: unknown
  readonly data?: unknown
  readonly error?: { readonly code?: string; readonly message?: string; readonly httpStatus?: number }
  readonly dataView?: string
  readonly unit?: string
  readonly [key: string]: unknown
}

export interface ZytNormalizeOptions {
  readonly provider?: string
  readonly operation: string
  readonly exitCode: number
  readonly transportId?: string
  readonly fetchedAt?: string
  readonly source?: string
  /**
   * `dataView` from `身份`/`me`: `internal` = real absolute values,
   * `external` = indexed quantities (first value = 100, never an absolute).
   * Flows into `provenance.caliber` and the Data gate (§5.2).
   */
  readonly dataView?: string
}

/** Caliber string for a zyt dataView; `undefined` when unknown. */
function zytCaliber(dataView: string | undefined): string | undefined {
  if (dataView === 'internal') return 'zyt.internal(真实绝对量)'
  if (dataView === 'external') return 'zyt.external(量类指数化；首值=100，勿当绝对量)'
  return undefined
}

/** Pull `unit` from a payload's `unit` field or its nested `data.unit`. */
function unitOf(payload: ZytCliPayload): string | undefined {
  if (typeof payload.unit === 'string') return payload.unit
  if (isRecord(payload.data) && typeof payload.data['unit'] === 'string') return payload.data['unit']
  return undefined
}

/**
 * Normalize a raw zyt `--json` result into a {@link ProviderEnvelope},
 * preserving exit-code semantics (0 success / 1 business parameter error /
 * 2 auth / 3 network 5xx), `dataView` caliber, and units.
 */
export function normalizeZytEnvelope(raw: ZytCliPayload, options: ZytNormalizeOptions): ProviderEnvelope {
  const provenance: ProvenanceInput = {
    provider: options.provider ?? 'zyt',
    operation: options.operation,
    transportId: options.transportId,
    fetchedAt: options.fetchedAt,
    source: options.source,
    caliber: zytCaliber(options.dataView),
  }
  const warnings: ProviderWarning[] = []
  if (options.dataView === 'external') {
    warnings.push({ code: 'zyt.external-indexed', message: 'dataView external：量类指数化（首值=100），不得当绝对量使用', severity: 'warning' })
  }
  const unit = unitOf(raw)
  const unitProvenance: ProvenanceInput = unit !== undefined ? { ...provenance, unit } : provenance

  if (options.exitCode === 0) {
    const err = raw.error
    if (err !== undefined) {
      const httpStatus = err.httpStatus
      const retry: RetryDirective = httpStatus !== undefined && httpStatus >= 500
        ? 'backoff'
        : httpStatus !== undefined && httpStatus >= 400
          ? 'correct-input'
          : 'never'
      return failEnvelope({
        code: err.code ?? 'ZYT_API_ERROR',
        retry,
        correction: err.message,
        details: { message: err.message, httpStatus },
      }, unitProvenance, warnings)
    }
    return okEnvelope(raw, unitProvenance, warnings)
  }

  switch (options.exitCode) {
    case 1:
      return failEnvelope({
        code: raw.error?.code ?? 'ZYT_BUSINESS_ERROR',
        retry: 'correct-input',
        correction: '修正业务参数（如城市不在允许列表 CITY_NOT_ALLOWED）',
        details: { message: raw.error?.message, httpStatus: raw.error?.httpStatus },
      }, unitProvenance, warnings)
    case 2:
      return failEnvelope({
        code: 'ZYT_AUTH_ERROR',
        retry: 'never',
        correction: '检查 X-Api-Key 凭据（flag > env > ~/.config/zyt/config.json）',
      }, unitProvenance, warnings)
    case 3:
      return failEnvelope({
        code: raw.error?.code ?? 'ZYT_NETWORK_ERROR',
        retry: 'backoff',
        details: { message: raw.error?.message, httpStatus: raw.error?.httpStatus },
      }, unitProvenance, warnings)
    default:
      return failEnvelope({
        code: raw.error?.code ?? 'ZYT_UNKNOWN_EXIT',
        retry: 'never',
        details: { exitCode: options.exitCode },
      }, unitProvenance, warnings)
  }
}

/* ------------------------------------------------------------------ *
 *  beike normalization (§5.3) — compensated error model.
 * ------------------------------------------------------------------ */

/**
 * Raw beike CLI result. Per the binary static analysis (§5.3): `--json`
 * stdout when the call succeeded, anyhow-style stderr on failure, and **no
 * stable business error codes** (clap parameter errors exit 2, panics 101).
 */
export interface BeikeRawResult {
  /** Process exit code (0 success; clap param errors → 2; panic → 101). */
  readonly exitCode: number
  /** Parsed `--json` stdout payload, when the binary produced one. */
  readonly json?: unknown
  /** Raw stderr text (anyhow error chain / clap usage). */
  readonly stderr?: string
}

export interface BeikeNormalizeOptions {
  readonly provider?: string
  readonly operation: string
  readonly transportId?: string
  readonly fetchedAt?: string
  readonly source?: string
  /** Data caliber note — 成交/均价口径 is server-defined and must survive (§5.3). */
  readonly caliber?: string
}

/** Cap on stderr kept in audit payloads. */
const BEIKE_STDERR_LIMIT = 2000

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Normalize a raw beike result into a {@link ProviderEnvelope} with the
 * §5.3 compensated error model: failures carry a **stable fallback code**
 * (`BEIKE_ERROR`, or a string code the payload itself carried) and
 * **never** an invented retry directive — `retry` is always `never` and the
 * caller decides. The exit code, bounded stderr and any `{error}` payload
 * stay in `error.details` for audit; `caliber` flows into
 * `provenance.caliber`; non-empty stderr on success becomes an
 * informational warning.
 */
export function normalizeBeikeEnvelope(raw: BeikeRawResult, options: BeikeNormalizeOptions): ProviderEnvelope {
  const provenance: ProvenanceInput = {
    provider: options.provider ?? 'beike',
    operation: options.operation,
    transportId: options.transportId,
    fetchedAt: options.fetchedAt,
    source: options.source,
    caliber: options.caliber,
  }
  const stderr = raw.stderr === undefined ? undefined : raw.stderr.slice(0, BEIKE_STDERR_LIMIT)
  if (raw.exitCode === 0) {
    if (raw.json === undefined) {
      return failEnvelope({
        code: 'BEIKE_EMPTY_RESPONSE',
        retry: 'never',
        correction: 'beike exited 0 but produced no --json payload',
        details: { stderr },
      }, provenance)
    }
    const warnings: ProviderWarning[] = []
    if (stderr !== undefined && stderr !== '') {
      warnings.push({ code: 'beike.stderr', message: stderr, severity: 'info' })
    }
    return okEnvelope(raw.json, provenance, warnings)
  }
  const payload = isRecord(raw.json) ? raw.json : undefined
  const errorPayload = payload !== undefined && isRecord(payload['error']) ? payload['error'] as Record<string, unknown> : undefined
  const code = stringOrUndefined(errorPayload?.['code']) ?? stringOrUndefined(payload?.['code']) ?? 'BEIKE_ERROR'
  const message = stringOrUndefined(errorPayload?.['message'])
  const correction = message ?? stringOrUndefined(stderr?.split('\n')[0])
  return failEnvelope({
    code,
    retry: 'never',
    ...(correction === undefined ? {} : { correction }),
    details: {
      exitCode: raw.exitCode,
      ...(stderr === undefined ? {} : { stderr }),
      ...(errorPayload === undefined ? {} : { error: errorPayload }),
    },
  }, provenance)
}

/* ------------------------------------------------------------------ *
 *  Immutability helpers.
 * ------------------------------------------------------------------ */

/** JSON round-trip clone — manifests and audit copies are JSON by contract. */
function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

/** Deep-freeze a plain JSON-safe value (idempotent on already-frozen parts). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/* ------------------------------------------------------------------ *
 *  ProviderRegistry — validated registration + capability index + audit.
 * ------------------------------------------------------------------ */

export type RegistryAuditKind = 'register' | 'replace' | 'unregister' | 'attach' | 'detach' | 'invoke'

/** One append-only registry event; frozen, never mutated after creation. */
export interface RegistryAuditEntry {
  readonly at: string
  readonly kind: RegistryAuditKind
  readonly providerId: string
  readonly version: string
  readonly detail?: string
  /** Operation id, on `invoke` records. */
  readonly operation?: string
  /** Outcome of an `invoke` record (`ok` | `fail`). */
  readonly outcome?: 'ok' | 'fail'
}

/** A registered provider: deep-frozen manifest plus lifecycle stamps. */
export interface RegisteredProvider {
  readonly manifest: ToolProviderManifest
  readonly registeredAt: string
  /** Set when {@link ProviderRegistry.unregister} removed the provider. */
  readonly removedAt?: string
}

export type RegisterResult =
  | { readonly ok: true; readonly registered: RegisteredProvider }
  | { readonly ok: false; readonly diagnostics: readonly PackDiagnostic[] }

export type UnregisterResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Point-in-time registry view, for provenance snapshots. */
export interface RegistrySnapshot {
  readonly takenAt: string
  readonly providers: readonly RegisteredProvider[]
}

/* ------------------------------------------------------------------ *
 *  Executable invoke seam — injected Host adapters (no raw transports).
 * ------------------------------------------------------------------ */

/**
 * What a {@link ProviderInvoker} adapter executes: one concrete operation of
 * its provider through the bound transport. Invokers are **injected Host
 * adapters** — this module never launches processes or opens sockets, so an
 * adapter may wrap a CLI, an MCP client or an HTTP API as the Host wires it.
 */
export interface InvokeAdapterRequest {
  /** Operation id inside the provider (from the resolved binding). */
  readonly operation: string
  /** Transport id the binding resolved to (for the adapter's routing). */
  readonly transportId?: string
  /** JSON-safe operation input. */
  readonly input: unknown
  /** Audit context (task/plan id…) forwarded to the adapter for logging. */
  readonly context?: string
  /** Caller cancellation signal forwarded to the Host transport runner. */
  readonly signal?: AbortSignal
}

/**
 * A Host-injected adapter that executes one provider's operations and returns
 * a normalized {@link ProviderEnvelope}. The returned envelope's
 * `provenance.provider` and `provenance.operation` MUST match the adapter's
 * `providerId` and the requested operation — the registry validates both and
 * rejects mismatches with a never-retry failure.
 */
export interface ProviderInvoker {
  /** Provider id this adapter serves; must match a registered provider. */
  readonly providerId: string
  invoke(request: InvokeAdapterRequest): Promise<ProviderEnvelope>
}

/** One invocation attempt of a previously resolved {@link CapabilityBinding}. */
export interface ProviderInvocationRequest {
  /** The frozen binding from {@link CapabilityResolver}; re-checked for staleness. */
  readonly binding: CapabilityBinding
  /** JSON-safe operation input. */
  readonly input: unknown
  /** Explicit approval required for `readOnly: false` (write) transports. */
  readonly approved?: boolean
  /** Audit context (task/plan id…). */
  readonly context?: string
  /** Caller cancellation signal forwarded to the invoker's transport runner. */
  readonly signal?: AbortSignal
}

export type AttachResult =
  | { readonly ok: true; readonly providerId: string }
  | { readonly ok: false; readonly reason: string }

export type DetachResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Validate a manifest with the same strict pack validator Domain Packs use. */
function manifestValidationErrors(manifest: ToolProviderManifest): readonly PackDiagnostic[] {
  const result = validateDomainPack({
    // The wrapped pack id is a constant (not derived from the manifest id) so
    // a long manifest id can never push it past the safe-id length limit.
    pack: { id: 'registry-pack', version: manifest.version, schemaVersion: SCHEMA_VERSION, name: manifest.id },
    experts: [],
    teamTemplates: [],
    outputTemplates: [],
    qualityPolicies: [],
    scenarios: [],
    toolProviders: [manifest],
    knowledgeProviders: [],
    domainKnowledge: [],
    methodPacks: [],
    skillPackages: [],
  })
  return result.diagnostics.filter(d => d.severity === 'error')
}

/**
 * Tool-provider registry (Phase 2). Owns every registered manifest as a
 * deep-frozen clone, indexes capabilities for the resolver, and records
 * every register/replace/unregister in an append-only audit log.
 */
export class ProviderRegistry {
  private readonly entries = new Map<string, RegisteredProvider>()
  private readonly auditLog: RegistryAuditEntry[] = []
  private readonly capabilityIndex = new Map<string, string[]>()
  private readonly invokers = new Map<string, ProviderInvoker>()

  /**
   * @param manifests - manifests to register eagerly; an invalid manifest
   *   throws with its validation diagnostics (a programming error at boot).
   */
  constructor(manifests: readonly ToolProviderManifest[] = []) {
    for (const manifest of manifests) {
      const result = this.register(manifest)
      if (!result.ok) {
        const messages = result.diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')
        throw new Error(`ProviderRegistry: invalid manifest "${manifest.id}": ${messages}`)
      }
    }
  }

  /**
   * Register a manifest. Fails on validation errors or on a duplicate id
   * unless `options.replace` is set (which supersedes the previous version
   * and records a `replace` audit entry).
   */
  register(manifest: ToolProviderManifest, options: { readonly replace?: boolean } = {}): RegisterResult {
    const errors = manifestValidationErrors(manifest)
    if (errors.length > 0) return Object.freeze({ ok: false, diagnostics: errors })

    const existing = this.entries.get(manifest.id)
    if (existing !== undefined && existing.removedAt === undefined && !options.replace) {
      return Object.freeze({
        ok: false,
        diagnostics: [{
          code: 'duplicate-provider',
          path: `toolProviders.${manifest.id}`,
          message: `provider "${manifest.id}" is already registered (v${existing.manifest.version}); pass { replace: true } to supersede it`,
          // `as const` keeps the literal type: `Object.freeze` is generic, so
          // without it `severity` would widen to `string` and the frozen
          // object would no longer satisfy RegisterResult's PackDiagnostic.
          severity: 'error' as const,
        }],
      })
    }

    const owned = deepFreeze(cloneJson(manifest))
    let registeredAt = new Date().toISOString()
    let kind: RegistryAuditKind = 'register'
    let detail: string | undefined
    if (existing !== undefined && existing.removedAt === undefined) {
      // Superseding an active registration keeps the original registration time.
      registeredAt = existing.registeredAt
      kind = 'replace'
      detail = `supersedes v${existing.manifest.version}`
    }
    const entry: RegisteredProvider = Object.freeze({ manifest: owned, registeredAt })
    this.entries.set(manifest.id, entry)
    this.recordAudit(kind, manifest.id, owned.version, detail)
    this.rebuildCapabilityIndex()
    return Object.freeze({ ok: true, registered: entry })
  }

  /**
   * Remove a provider; its capability entries stop resolving immediately.
   * Lifecycle hardening: any attached invoker is detached as part of the
   * removal, so re-registering the same id can never accidentally reuse a
   * stale adapter bound to the old incarnation. The detach is recorded as a
   * deterministic `detach` audit entry immediately before the `unregister`
   * entry.
   */
  unregister(id: string): UnregisterResult {
    const existing = this.entries.get(id)
    if (existing === undefined || existing.removedAt !== undefined) {
      return Object.freeze({ ok: false, reason: `provider "${id}" is not registered` })
    }
    const removed: RegisteredProvider = Object.freeze({ ...existing, removedAt: new Date().toISOString() })
    this.entries.set(id, removed)
    if (this.invokers.has(id)) {
      this.invokers.delete(id)
      this.recordAudit('detach', id, existing.manifest.version, 'detached by unregister')
    }
    this.recordAudit('unregister', id, existing.manifest.version)
    this.rebuildCapabilityIndex()
    return Object.freeze({ ok: true })
  }

  /** The frozen registration record for one provider id. */
  get(id: string): RegisteredProvider | undefined {
    return this.entries.get(id)
  }

  /** All registrations (including removed ones, marked `removedAt`). */
  list(): readonly RegisteredProvider[] {
    return deepFreeze([...this.entries.values()].map(entry => cloneJson(entry)))
  }

  /** Immutable point-in-time view for provenance audit. */
  snapshot(): RegistrySnapshot {
    return deepFreeze({ takenAt: new Date().toISOString(), providers: this.list() })
  }

  /** Active providers declaring the given capability, in registration order. */
  resolveCapability(capability: string): readonly RegisteredProvider[] {
    const ids = this.capabilityIndex.get(capability) ?? []
    const providers: RegisteredProvider[] = []
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (entry !== undefined && entry.removedAt === undefined) providers.push(entry)
    }
    return deepFreeze(providers)
  }

  /** Append-only audit trail (register/replace/unregister/attach/detach/invoke). */
  audit(): readonly RegistryAuditEntry[] {
    return deepFreeze(this.auditLog.map(entry => ({ ...entry })))
  }

  /**
   * Attach a Host-provided {@link ProviderInvoker} to a registered provider.
   * Fails when the provider is not registered (register first) or when an
   * invoker is already attached (pass `replace: true` to swap adapters).
   */
  attach(invoker: ProviderInvoker, options: { readonly replace?: boolean } = {}): AttachResult {
    const entry = this.entries.get(invoker.providerId)
    if (entry === undefined || entry.removedAt !== undefined) {
      return Object.freeze({ ok: false, reason: `provider "${invoker.providerId}" is not registered; register the provider before attaching an invoker` })
    }
    const replacing = this.invokers.has(invoker.providerId)
    if (replacing && !options.replace) {
      return Object.freeze({ ok: false, reason: `an invoker is already attached to provider "${invoker.providerId}"; pass { replace: true } to swap it` })
    }
    this.invokers.set(invoker.providerId, invoker)
    this.recordAudit('attach', invoker.providerId, entry.manifest.version, replacing ? 'replaces previous adapter' : undefined)
    return Object.freeze({ ok: true, providerId: invoker.providerId })
  }

  /** Detach the invoker of a provider; invocation afterwards fails. */
  detach(providerId: string): DetachResult {
    const entry = this.entries.get(providerId)
    if (entry === undefined) return Object.freeze({ ok: false, reason: `provider "${providerId}" is not registered` })
    if (!this.invokers.has(providerId)) return Object.freeze({ ok: false, reason: `no invoker is attached to provider "${providerId}"` })
    this.invokers.delete(providerId)
    this.recordAudit('detach', providerId, entry.manifest.version)
    return Object.freeze({ ok: true })
  }

  /** Whether an invoker is attached to the given registered provider. */
  hasInvoker(providerId: string): boolean {
    return this.invokers.has(providerId)
  }

  /**
   * Invoke a resolved binding through the attached invoker. The binding is
   * re-validated against the current registry before each call — a provider
   * that was unregistered, replaced with another version, or whose operation
   * or transport no longer exists makes the binding stale; `readOnly: false`
   * transports require an explicit `approved: true`; and the invoker's
   * returned envelope must carry provenance matching the binding. The result
   * is deep-frozen and an `invoke` audit record is appended. No raw
   * transport is ever executed here — the invoker is the injected adapter.
   */
  async invoke(request: ProviderInvocationRequest): Promise<ProviderEnvelope> {
    const binding = request.binding
    const baseProvenance: ProvenanceInput = {
      provider: binding.providerId,
      operation: binding.operation,
      fetchedAt: new Date().toISOString(),
    }
    const fail = (code: string, detail: string, correction: string, details?: unknown): ProviderEnvelope => {
      const envelope = failEnvelope({ code, retry: 'never', correction, ...(details === undefined ? {} : { details }) }, baseProvenance)
      this.recordAudit('invoke', binding.providerId, binding.providerVersion, detail, binding.operation, 'fail')
      return envelope
    }

    // 1. Stale-binding rejection: a binding is only valid against the exact
    //    provider version/operation/transport it was resolved for (§4.3:
    //    execution consumes only the frozen plan, so bindings must be re-valid).
    const stale = bindingStaleness(binding, this)
    if (stale !== undefined) {
      return fail('binding-stale', `stale: ${stale}`, 're-resolve the capability binding before invoking', { reason: stale })
    }

    // 2. Write gate: `readOnly: false` transports require explicit approval.
    const entry = this.entries.get(binding.providerId)
    const transport = entry?.manifest.transports.find(candidate => candidate.id === binding.transportId)
    if (transport?.readOnly === false && request.approved !== true) {
      return fail('write-requires-approval', 'write without approval', 'obtain explicit user approval for this write operation before invoking', { transportId: binding.transportId })
    }

    // 3. Invoker lookup — the Host adapter must be attached.
    const invoker = this.invokers.get(binding.providerId)
    if (invoker === undefined) {
      return fail('no-invoker-attached', 'no invoker attached', 'attach a Host provider adapter for this provider before invoking', { providerId: binding.providerId })
    }

    // 4. Execute through the injected adapter (never a raw shell/network call).
    let envelope: ProviderEnvelope
    try {
      envelope = await invoker.invoke({
        operation: binding.operation,
        transportId: binding.transportId,
        input: request.input,
        ...(request.context === undefined ? {} : { context: request.context }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (error: unknown) {
      return fail('invoker-threw', 'invoker threw', 'provider adapter crashed; check the invoker implementation', { message: error instanceof Error ? error.message : String(error) })
    }

    // 5. Provenance validation: the adapter must report the exact provider
    //    and operation the binding authorized.
    if (!isRecord(envelope) || typeof envelope['ok'] !== 'boolean' || !isRecord(envelope['provenance'])) {
      return fail('invalid-provider-envelope', 'invalid envelope from invoker', 'the attached invoker must return a ProviderEnvelope with provenance', { reason: 'not a ProviderEnvelope' })
    }
    const prov = envelope['provenance'] as Record<string, unknown>
    if (prov['provider'] !== binding.providerId) {
      return fail('provenance-provider-mismatch', `provenance provider ${String(prov['provider'])} != ${binding.providerId}`, 'the attached invoker reported provenance for a different provider', { expected: binding.providerId, got: prov['provider'] })
    }
    if (prov['operation'] !== binding.operation) {
      return fail('provenance-operation-mismatch', `provenance operation ${String(prov['operation'])} != ${binding.operation}`, 'the attached invoker reported provenance for a different operation', { expected: binding.operation, got: prov['operation'] })
    }

    // 6. Freeze the result and audit it (§4.5: every provider call is recorded).
    this.recordAudit('invoke', binding.providerId, binding.providerVersion, undefined, binding.operation, envelope.ok ? 'ok' : 'fail')
    return deepFreeze(envelope)
  }

  private recordAudit(
    kind: RegistryAuditKind,
    providerId: string,
    version: string,
    detail?: string,
    operation?: string,
    outcome?: 'ok' | 'fail',
  ): void {
    this.auditLog.push(Object.freeze({ at: new Date().toISOString(), kind, providerId, version, detail, operation, outcome }))
  }

  private rebuildCapabilityIndex(): void {
    this.capabilityIndex.clear()
    for (const entry of this.entries.values()) {
      if (entry.removedAt !== undefined) continue
      for (const capability of entry.manifest.capabilities) {
        const providers = this.capabilityIndex.get(capability.capability)
        if (providers === undefined) this.capabilityIndex.set(capability.capability, [entry.manifest.id])
        else if (!providers.includes(entry.manifest.id)) providers.push(entry.manifest.id)
      }
    }
  }
}

/**
 * Why a resolved binding no longer matches the current registry, or
 * `undefined` when it is still valid. Invocation refuses stale bindings:
 * execution consumes only the frozen plan (§4.3), so the provider's current
 * manifest must still declare the exact version/operation/transport the
 * binding was resolved for.
 */
function bindingStaleness(binding: CapabilityBinding, registry: ProviderRegistry): string | undefined {
  const entry = registry.get(binding.providerId)
  if (entry === undefined) return `provider-not-registered:${binding.providerId}`
  if (entry.removedAt !== undefined) return `provider-removed:${binding.providerId}`
  if (entry.manifest.version !== binding.providerVersion) return `provider-version-changed:${binding.providerVersion}->${entry.manifest.version}`
  const capability = entry.manifest.capabilities.find(candidate => candidate.capability === binding.capability && candidate.operation === binding.operation)
  if (capability === undefined) return `operation-missing:${binding.operation}`
  if (capability.transportId !== undefined && capability.transportId !== binding.transportId) return `transport-rebound:${binding.transportId}->${capability.transportId}`
  if (!entry.manifest.transports.some(transport => transport.id === binding.transportId)) return `transport-missing:${binding.transportId}`
  return undefined
}

/* ------------------------------------------------------------------ *
 *  CapabilityResolver — §4.1 intersection, auditable bindings.
 * ------------------------------------------------------------------ */

/** Freshness ladder used for `minFreshness` comparisons. */
const FRESHNESS_RANK: Readonly<Record<string, number>> = { static: 0, monthly: 1, daily: 2, realtime: 3 }

function freshnessRank(value: string): number {
  return FRESHNESS_RANK[value] ?? 0
}

/** Constraints narrowing the §4.1 intersection for one capability request. */
export interface ResolveConstraints {
  /** Ordered allowed provider ids (preference + filter); empty = any installed provider. */
  readonly allowedProviders?: readonly string[]
  /** Task-level capability allowlist; the requested capability must be listed. */
  readonly capabilityAllowlist?: ReadonlySet<string> | readonly string[]
  /** credentialRefs available to this session; when given, missing credentials block. */
  readonly availableCredentials?: ReadonlySet<string> | readonly string[]
  /** Bind only read-only transports (default true — writes need approval gates). */
  readonly readOnly?: boolean
  /** Minimum acceptable data freshness (static < monthly < daily < realtime). */
  readonly minFreshness?: 'static' | 'monthly' | 'daily' | 'realtime'
  /** Scenario-declared substitution pairs (§3.4 ToolPolicy.fallbacks). */
  readonly fallbacks?: readonly { readonly from: string; readonly to: string }[]
}

/** One capability the resolver is asked to bind. */
export interface ResolveRequest {
  /** Dotted capability id (e.g. `financial.stock.snapshot`). */
  readonly capability: string
  readonly constraints?: ResolveConstraints
  /** Why this capability is needed — recorded in the plan for audit. */
  readonly context?: string
}

export type ResolveStatus = 'bound' | 'denied' | 'unavailable'

/**
 * An immutable capability → `provider.operation + transport` binding. Every
 * field is fixed at resolve time and the object is frozen: it can be stored,
 * audited and replayed, but never amended.
 */
export interface CapabilityBinding {
  /** The capability the bound operation actually serves (post-fallback value). */
  readonly capability: string
  readonly providerId: string
  readonly providerVersion: string
  readonly operation: string
  readonly transportId: string
  /** Caliber declared by the provider for this capability (e.g. zyt dataView). */
  readonly caliber?: string
  /** Why this binding won: the gate chain ∩ the chosen operation@transport. */
  readonly reason: string
  readonly boundAt: string
}

/** One candidate that did not bind, with the reason it was rejected. */
export interface CandidateRejection {
  readonly providerId: string
  readonly operation: string
  readonly reason: string
}

/** Result of resolving one capability. */
export interface ResolveResult {
  readonly capability: string
  readonly status: ResolveStatus
  readonly binding?: CapabilityBinding
  readonly rejections: readonly CandidateRejection[]
}

/** Immutable plan over many requests — the BindingPlan (§4.3), JSON-safe. */
export interface BindingPlan {
  readonly resolvedAt: string
  readonly requests: readonly ResolveRequest[]
  readonly results: readonly ResolveResult[]
  readonly bindings: readonly CapabilityBinding[]
}

function normalizeSet(value: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  return typeof (value as { has?: unknown }).has === 'function' ? value as ReadonlySet<string> : new Set(value)
}

/** Order candidates by `allowedProviders` preference; the rest stay for rejection reporting. */
function orderedCandidates(providers: readonly RegisteredProvider[], allowed: readonly string[] | undefined): readonly RegisteredProvider[] {
  if (allowed === undefined || allowed.length === 0) return providers
  const allowedSet = new Set(allowed)
  const rank = new Map(allowed.map((id, index) => [id, index] as const))
  const inAllowed: RegisteredProvider[] = []
  const rest: RegisteredProvider[] = []
  for (const provider of providers) {
    if (allowedSet.has(provider.manifest.id)) inAllowed.push(provider)
    else rest.push(provider)
  }
  inAllowed.sort((a, b) => (rank.get(a.manifest.id) ?? 0) - (rank.get(b.manifest.id) ?? 0))
  return [...inAllowed, ...rest]
}

/** Pick the transport a capability entry binds to (explicit id, or the first). */
function pickTransport(manifest: ToolProviderManifest, capability: ToolCapability): { readonly transport?: ToolTransport; readonly rejection?: string } {
  if (capability.transportId !== undefined) {
    const transport = manifest.transports.find(t => t.id === capability.transportId)
    return transport !== undefined ? { transport } : { rejection: `dangling-transport:${capability.transportId}` }
  }
  const first = manifest.transports[0]
  return first !== undefined ? { transport: first } : { rejection: 'no-transport' }
}

/** Human-auditable "why": the gate chain that this binding passed. */
function buildBindingReason(constraints: ResolveConstraints, capability: ToolCapability, transport: ToolTransport): string {
  const gates: string[] = ['capability', 'provider-installed']
  if (constraints.capabilityAllowlist !== undefined) gates.push('allowlist')
  if (constraints.allowedProviders !== undefined) gates.push('allowed-providers')
  if (constraints.availableCredentials !== undefined) gates.push('credentials')
  if (constraints.minFreshness !== undefined) gates.push('freshness')
  gates.push(transport.readOnly === false ? 'write-transport' : 'read-only')
  return `${gates.join(' ∩ ')} → ${capability.operation}@${transport.id}`
}

function freezeBinding(binding: CapabilityBinding): CapabilityBinding {
  return Object.freeze(binding)
}

function freezeResult(result: ResolveResult): ResolveResult {
  for (const rejection of result.rejections) Object.freeze(rejection)
  Object.freeze(result.rejections)
  if (result.binding !== undefined) Object.freeze(result.binding)
  return Object.freeze(result)
}

/** JSON-safe audit copy of a request: Sets are widened to arrays. */
function requestForAudit(request: ResolveRequest): ResolveRequest {
  const constraints = request.constraints
  return Object.freeze({
    capability: request.capability,
    context: request.context,
    constraints: constraints === undefined
      ? undefined
      : Object.freeze({
        ...(constraints.allowedProviders !== undefined ? { allowedProviders: [...constraints.allowedProviders] } : {}),
        ...(constraints.capabilityAllowlist !== undefined ? { capabilityAllowlist: [...normalizeSet(constraints.capabilityAllowlist)!] } : {}),
        ...(constraints.availableCredentials !== undefined ? { availableCredentials: [...normalizeSet(constraints.availableCredentials)!] } : {}),
        ...(constraints.readOnly !== undefined ? { readOnly: constraints.readOnly } : {}),
        ...(constraints.minFreshness !== undefined ? { minFreshness: constraints.minFreshness } : {}),
        ...(constraints.fallbacks !== undefined ? { fallbacks: constraints.fallbacks.map(fallback => ({ ...fallback })) } : {}),
      }),
  })
}

/**
 * Binds required capabilities to concrete providers (§4.1). The intersection
 * is: task capability allowlist ∩ installed providers ∩ allowed providers ∩
 * credential availability ∩ read-only policy ∩ data freshness. Substitution
 * only through explicitly declared fallbacks — never implicit (Wind and zyt
 * do not back each other up, §5.3).
 */
export class CapabilityResolver {
  constructor(private readonly registry: ProviderRegistry) {}

  /** Resolve one capability to a binding (or a denial with reasons). */
  resolve(request: ResolveRequest): ResolveResult {
    return this.resolveOne(request.capability, request.constraints ?? {}, new Set([request.capability]))
  }

  /** Resolve many capabilities into an immutable, auditable plan. */
  resolveAll(requests: readonly ResolveRequest[]): BindingPlan {
    const results = requests.map(request => this.resolve(request))
    const bindings: CapabilityBinding[] = []
    for (const result of results) {
      if (result.binding !== undefined) bindings.push(result.binding)
    }
    const plan: BindingPlan = {
      resolvedAt: new Date().toISOString(),
      requests: requests.map(request => requestForAudit(request)),
      results: deepFreeze(results),
      bindings: deepFreeze(bindings),
    }
    return Object.freeze(plan)
  }

  private resolveOne(capability: string, constraints: ResolveConstraints, visited: Set<string>): ResolveResult {
    const rejections: CandidateRejection[] = []

    // 1. Task capability allowlist gate.
    const allowlist = normalizeSet(constraints.capabilityAllowlist)
    if (allowlist !== undefined && !allowlist.has(capability)) {
      return freezeResult({
        capability,
        status: 'denied',
        rejections: [{ providerId: '(policy)', operation: capability, reason: 'capability-not-allowlisted' }],
      })
    }

    // 2-6. Installed ∩ allowed ∩ credentials ∩ read-only ∩ freshness.
    const allowed = constraints.allowedProviders
    const allowedSet = allowed !== undefined ? new Set(allowed) : undefined
    const credentials = normalizeSet(constraints.availableCredentials)
    const readOnly = constraints.readOnly !== false
    const candidates = orderedCandidates(this.registry.resolveCapability(capability), allowed)

    for (const candidate of candidates) {
      const manifest = candidate.manifest
      if (allowedSet !== undefined && !allowedSet.has(manifest.id)) {
        rejections.push({ providerId: manifest.id, operation: capability, reason: 'provider-not-allowed' })
        continue
      }
      const matched = manifest.capabilities.filter(entry => entry.capability === capability)
      for (const capabilityEntry of matched) {
        const transportResult = pickTransport(manifest, capabilityEntry)
        if (transportResult.rejection !== undefined) {
          rejections.push({ providerId: manifest.id, operation: capabilityEntry.operation, reason: transportResult.rejection })
          continue
        }
        const transport = transportResult.transport as ToolTransport
        if (readOnly && transport.readOnly === false) {
          rejections.push({ providerId: manifest.id, operation: capabilityEntry.operation, reason: 'write-transport-requires-approval' })
          continue
        }
        if (credentials !== undefined && transport.auth?.credentialRef !== undefined && !credentials.has(transport.auth.credentialRef)) {
          rejections.push({ providerId: manifest.id, operation: capabilityEntry.operation, reason: `missing-credential:${transport.auth.credentialRef}` })
          continue
        }
        if (constraints.minFreshness !== undefined && freshnessRank(capabilityEntry.freshness ?? 'static') < freshnessRank(constraints.minFreshness)) {
          rejections.push({ providerId: manifest.id, operation: capabilityEntry.operation, reason: `freshness-insufficient:${capabilityEntry.freshness ?? 'static'}<${constraints.minFreshness}` })
          continue
        }
        const binding = freezeBinding({
          capability,
          providerId: manifest.id,
          providerVersion: manifest.version,
          operation: capabilityEntry.operation,
          transportId: transport.id,
          caliber: capabilityEntry.caliber,
          reason: buildBindingReason(constraints, capabilityEntry, transport),
          boundAt: new Date().toISOString(),
        })
        return freezeResult({ capability, status: 'bound', binding, rejections })
      }
    }

    // 7. Explicit fallback only — never implicit Wind↔zyt substitution (§4.1).
    const fallbackTo = constraints.fallbacks?.find(fallback => fallback.from === capability)?.to
    if (fallbackTo !== undefined && !visited.has(fallbackTo)) {
      visited.add(fallbackTo)
      const fallbackResult = this.resolveOne(fallbackTo, { ...constraints, fallbacks: undefined }, visited)
      if (fallbackResult.binding !== undefined) {
        const binding = freezeBinding({
          ...fallbackResult.binding,
          reason: `fallback:${capability}→${fallbackTo}; ${fallbackResult.binding.reason}`,
        })
        return freezeResult({ capability, status: 'bound', binding, rejections: [...rejections, ...fallbackResult.rejections] })
      }
      rejections.push(...fallbackResult.rejections)
    }

    return freezeResult({ capability, status: 'unavailable', rejections })
  }
}
