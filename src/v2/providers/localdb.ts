/**
 * localdb provider — flexible registration of local SQLite databases.
 *
 * Like wind/zyt/beike this module is JSON-safe and performs **no I/O**: it
 * builds a `ToolProviderManifest` from a caller-supplied database list,
 * plans the exact `python3 <runner> '<json>'` argv for one operation, and
 * normalizes the runner's stdout envelope into a {@link ProviderEnvelope}.
 * The Host wires the declared `local-cli` transport to its injected spawn
 * runner (never a shell; the JSON request travels as one explicit argv item).
 *
 * Flexible registration: the database list comes from plugin config
 * (`providers.localdb.databases`), the `LOCALDB_DATABASES` env JSON, and/or
 * auto-discovery of `*.db|*.sqlite|*.sqlite3` files under configured
 * `scanDirs` (resolved in provider-service.ts). Every registered database
 * exposes two capabilities: `localdb.<id>.schema` (tables/columns overview)
 * and `localdb.<id>.query` (single read-only SELECT/WITH). Files that do not
 * exist at registration time are skipped — fail closed, never invented.
 *
 * Safety: the runner opens the file with a `file:...?mode=ro` URI, accepts
 * exactly one SELECT/WITH statement and bounds rows (see
 * assets/localdb_runner.py). Writes are impossible at the SQLite layer.
 *
 * @module dsh-expert-library/v2/providers/localdb
 */

import {
  failEnvelope,
  okEnvelope,
  type ProviderEnvelope,
  type ProvenanceInput,
} from '../provider-runtime.ts'
import type { ToolCapability, ToolProviderManifest } from '../types.ts'
import { SCHEMA_VERSION } from '../types.ts'

/* ------------------------------------------------------------------ *
 *  Registration shape.
 * ------------------------------------------------------------------ */

/** One registered local database (from config, env or scan discovery). */
export interface LocalDbDatabase {
  /** Stable id used in capability/dataset names (`localdb.<id>.*`). */
  readonly id: string
  /** Absolute path to the SQLite file. */
  readonly path: string
  /** Optional human description (caveats). */
  readonly description?: string
  /** Data caliber stamped into provenance (default provided). */
  readonly caliber?: string
  /** `public` (default) or `internal` — internal appends a 勿外发 caveat. */
  readonly sensitivity?: 'public' | 'internal'
}

/** Operations served per database. */
export const LOCALDB_KINDS = ['schema', 'query'] as const
export type LocalDbKind = (typeof LOCALDB_KINDS)[number]

export const DEFAULT_LOCALDB_CALIBER = '本地 SQLite 只读查询（以库内字段口径为准）'
export const LOCALDB_RUNNER_ASSET = '../../assets/localdb_runner.py'

/** True when the id is safe to embed in a capability name. */
export function isValidLocalDbId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

/** Resolve the runner asset path against this module's URL (src or lib layout). */
export function defaultLocalDbRunnerPath(moduleUrl: string): string {
  return new URL(LOCALDB_RUNNER_ASSET, moduleUrl).pathname
}

/** Caliber for one database (sensitivity-aware). */
export function caliberOf(db: LocalDbDatabase): string {
  const base = db.caliber ?? DEFAULT_LOCALDB_CALIBER
  return db.sensitivity === 'internal' ? `${base}；行内材料·勿外发` : base
}

/**
 * Build the localdb provider manifest. Databases with invalid ids or missing
 * files are skipped silently by the caller (resolveLocalDbOptions); this
 * builder assumes a validated list. A caller may still pass an empty list —
 * the manifest then carries no capabilities and the caller must not register
 * it (the service registers only when at least one database survived).
 */
export function buildLocalDbManifest(databases: readonly LocalDbDatabase[], options: {
  runnerPath: string
  version?: string
  timeoutMs?: number
}): ToolProviderManifest {
  const { runnerPath, version = '1.0.0', timeoutMs = 30_000 } = options
  const capabilities: ToolCapability[] = databases.flatMap(db =>
    LOCALDB_KINDS.map(kind => ({
      capability: `localdb.${db.id}.${kind}`,
      operation: `localdb.${db.id}.${kind}`,
      transportId: 'sqlite-ro',
      caliber: caliberOf(db),
      freshness: 'static' as const,
    })),
  )
  return {
    id: 'localdb',
    version,
    schemaVersion: SCHEMA_VERSION,
    capabilities,
    transports: [
      {
        kind: 'local-cli',
        id: 'sqlite-ro',
        command: 'python3',
        args: [runnerPath],
        workingDirectory: dirnameOf(runnerPath),
        timeoutMs,
        readOnly: true,
      },
    ],
    caveats: [
      '只读通道：SQLite 以 mode=ro 打开，仅接受单条 SELECT/WITH',
      '行数上限 1000，截断时 provenance.truncated=true，禁把截断当全量',
      'schema 模式先探查表结构，再写 query；TABLE_NOT_FOUND 先回 schema',
      'internal 敏感级的库输出带「行内材料·勿外发」，外发前必须人工确认',
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
export interface LocalDbCallPlan {
  /** One JSON argv item consumed by assets/localdb_runner.py. */
  readonly args: readonly string[]
}

/** Parse a capability id `localdb.<id>.<kind>` into its parts. */
export function parseLocalDbOperation(operation: string): { id: string; kind: LocalDbKind } | undefined {
  const parts = operation.split('.')
  if (parts.length !== 3 || parts[0] !== 'localdb') return undefined
  const kind = parts[2]
  if (kind !== 'schema' && kind !== 'query') return undefined
  return { id: parts[1]!, kind }
}

/**
 * Build the single-argv JSON request for one localdb operation.
 * `query` requires `input.sql`; `schema` accepts optional `input.table`.
 */
export function localDbCallPlan(db: LocalDbDatabase, operation: string, input: unknown): LocalDbCallPlan {
  const parsed = parseLocalDbOperation(operation)
  if (parsed === undefined || parsed.id !== db.id) {
    throw new Error(`unknown localdb operation: ${operation}`)
  }
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const request: Record<string, unknown> = {
    db: db.path,
    mode: parsed.kind,
    capability: operation,
    caliber: caliberOf(db),
  }
  if (parsed.kind === 'query') {
    const sql = record['sql']
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new Error('query 需要 input.sql（单条 SELECT/WITH）')
    }
    request['sql'] = sql
    if (typeof record['limit'] === 'number' && Number.isFinite(record['limit'])) request['limit'] = record['limit']
  } else if (typeof record['table'] === 'string' && record['table'] !== '') {
    request['table'] = record['table']
  }
  return { args: [JSON.stringify(request)] }
}

/* ------------------------------------------------------------------ *
 *  Runner-output normalization.
 * ------------------------------------------------------------------ */

/** Raw result of one runner invocation (Host spawn runner output). */
export interface LocalDbCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr?: string
}

export interface LocalDbNormalizeOptions {
  readonly operation: string
  readonly transportId: string
  /** Expected db path (provenance.source fallback). */
  readonly source: string
  readonly caliber: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function provenanceOf(options: LocalDbNormalizeOptions, extra?: Record<string, unknown>): ProvenanceInput {
  return {
    provider: 'localdb',
    operation: options.operation,
    transportId: options.transportId,
    source: options.source,
    caliber: options.caliber,
    ...extra,
  }
}

/**
 * Normalize the runner's stdout envelope. The runner already speaks the
 * platform shape, so this is a validating passthrough: unparseable or
 * non-conforming output fails closed with `LOCALDB_INVALID_RUNNER_OUTPUT`;
 * `ok:false` maps onto the runtime failure envelope (always `never` — local
 * file errors do not improve by retrying).
 */
export function normalizeLocalDbCliOutput(raw: LocalDbCliResult, options: LocalDbNormalizeOptions): ProviderEnvelope {
  const stderr = raw.stderr === undefined ? undefined : raw.stderr.slice(0, 2000)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.stdout)
  } catch {
    return failEnvelope({
      code: 'LOCALDB_INVALID_RUNNER_OUTPUT',
      retry: 'never',
      correction: 'runner stdout 不是 JSON（进程崩溃或输出被截断）',
      details: { exitCode: raw.exitCode, ...(stderr === undefined ? {} : { stderr }) },
    }, provenanceOf(options))
  }
  if (!isRecord(parsed) || typeof parsed['ok'] !== 'boolean') {
    return failEnvelope({
      code: 'LOCALDB_INVALID_RUNNER_OUTPUT',
      retry: 'never',
      correction: 'runner stdout 必须是带 ok 布尔字段的平台信封 JSON',
      details: { exitCode: raw.exitCode },
    }, provenanceOf(options))
  }
  const provenanceIn = isRecord(parsed['provenance']) ? parsed['provenance'] as Record<string, unknown> : {}
  if (parsed['ok'] === false) {
    const error = isRecord(parsed['error']) ? parsed['error'] as Record<string, unknown> : {}
    const code = typeof error['code'] === 'string' && error['code'] !== '' ? error['code'] : 'LOCALDB_ERROR'
    const correction = typeof error['correction'] === 'string' ? error['correction'] : undefined
    const message = typeof error['message'] === 'string' ? error['message'] : undefined
    return failEnvelope({
      code,
      retry: 'never',
      ...(correction === undefined ? {} : { correction }),
      details: { ...(message === undefined ? {} : { message }), exitCode: raw.exitCode },
    }, provenanceOf(options, { ...(provenanceIn['source'] !== undefined ? { runnerSource: provenanceIn['source'] } : {}) }))
  }
  const warnings: { code: string; message: string; severity: 'warning' }[] = []
  if (provenanceIn['truncated'] === true) {
    warnings.push({ code: 'localdb.truncated', message: '结果超过行数上限已截断，禁把截断结果当全量引用', severity: 'warning' })
  }
  const data = parsed['data'] ?? null
  const envelope = okEnvelope(
    { ...(isRecord(data) ? data : { value: data }) },
    provenanceOf(options, {
      ...(provenanceIn['row_count'] !== undefined ? { row_count: provenanceIn['row_count'] } : {}),
      ...(provenanceIn['truncated'] !== undefined ? { truncated: provenanceIn['truncated'] } : {}),
      ...(provenanceIn['fetched_at'] !== undefined ? { fetched_at: provenanceIn['fetched_at'] } : {}),
    }),
    warnings,
  )
  return envelope
}
