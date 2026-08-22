/**
 * Host health-observation surface — pure, dependency-injected probes behind
 * `GET /plugins/dsh-expert-library/health?probe=<wind|zyt|beike|packs|all>`.
 *
 * Design rules:
 * - Every I/O seam is injectable ({@link HealthSeams}): fetch / exists /
 *   readFile / env / home / clock, so contract tests run hermetic with fakes
 *   (same pattern as `provider-transports.ts`). The real seams are
 *   {@link createNodeHealthSeams}.
 * - Probes are READ-ONLY and side-effect free: the wind probe never runs the
 *   CLI, zyt/beike probes are single bounded HTTP calls (8s default), and the
 *   packs probe only recomputes the deterministic tree digest — it NEVER
 *   writes (the generator scripts own every write).
 * - Secrets never cross the wire: the response carries only `keyPresent`
 *   booleans plus non-secret metadata (base URLs, latency, identity names).
 *   API keys are read from the environment/config files, used in request
 *   headers, and never copied into any result field.
 * - A 30s in-process cache ({@link HealthProbeCache}) keyed by probe target
 *   makes the route single-flight: concurrent requests for the same target
 *   share one probe run.
 *
 * @module dsh-expert-library/host/health
 */

import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { hashPackageTree } from '../v2/pack-loader.ts'
import { extractZytApiKey } from '../v2/providers/zyt.ts'
import { createNodeFetchRunner, type FetchFn } from './provider-transports.ts'

/* ------------------------------------------------------------------ *
 *  Wire shapes (mirrored by the settings page client).
 * ------------------------------------------------------------------ */

/** Probe targets accepted by the health route. */
export type HealthProbeTarget = 'wind' | 'zyt' | 'beike' | 'packs' | 'all'

/** Every valid probe target (route input validation). */
export const HEALTH_PROBE_TARGETS: readonly HealthProbeTarget[] = ['wind', 'zyt', 'beike', 'packs', 'all']

/** Wind probe result (filesystem-only; no network, no CLI execution). */
export interface WindHealth {
  readonly registered: boolean
  /** Resolved CLI path candidate, when known (settings > env > default probe). */
  readonly cliPath?: string
  readonly cliExists: boolean
  readonly keyPresent: boolean
  readonly detail?: string
}

/** zyt identity metadata parsed from `/openapi/v1/me` (non-secret). */
export interface ZytIdentity {
  readonly tenantName?: string
  readonly dataView?: string
}

/** zyt probe result. */
export interface ZytHealth {
  readonly registered: boolean
  readonly baseUrl: string
  readonly keyPresent: boolean
  /** Present only when a network probe ran (a key is configured). */
  readonly reachable?: boolean
  readonly latencyMs?: number
  readonly identity?: ZytIdentity
  readonly detail?: string
}

/** beike probe result. */
export interface BeikeHealth {
  readonly registered: boolean
  readonly baseUrl: string
  readonly keyPresent: boolean
  readonly reachable?: boolean
  readonly latencyMs?: number
  /** `<name> <version>` from the MCP initialize handshake, when parseable. */
  readonly serverInfo?: string
  readonly detail?: string
}

/** Drift verdict of a generated pack tree against its recorded digest. */
export type PackDrift = 'clean' | 'dirty' | 'unknown'

/** One pack row of the health report. */
export interface PackHealth {
  readonly id: string
  readonly version: string
  readonly experts: number
  readonly scenarios: number
  /** Recomputed deterministic tree sha256 over the non-generated files. */
  readonly sha256: string
  /** `clean` = matches `generated/pack.sha256`; `unknown` = no reference hash. */
  readonly drift: PackDrift
}

/** Full wire body of the health route. */
export interface HealthReport {
  readonly checkedAt: string
  readonly providers: {
    readonly wind: WindHealth
    readonly zyt: ZytHealth
    readonly beike: BeikeHealth
  }
  readonly packs: readonly PackHealth[]
}

/* ------------------------------------------------------------------ *
 *  Injectable seams.
 * ------------------------------------------------------------------ */

/** I/O seams of the health probes; tests substitute fakes. */
export interface HealthSeams {
  readonly fetch: FetchFn
  /** Synchronous existence check (CLI path, credential files). */
  readonly exists: (path: string) => boolean
  /** Read a UTF-8 file, `undefined` when absent/unreadable. */
  readonly readFile: (path: string) => string | undefined
  /** Read an environment variable. */
  readonly env: (name: string) => string | undefined
  /** Home directory for `~` config paths. */
  readonly home: () => string
  /** Monotonic clock (ms) for latency measurement. */
  readonly now: () => number
}

/** Real seams over Node fs/process; `overrides` replace individual seams. */
export function createNodeHealthSeams(overrides: Partial<HealthSeams> = {}): HealthSeams {
  return {
    fetch: overrides.fetch ?? createNodeFetchRunner(),
    exists: overrides.exists ?? ((path) => existsSync(path)),
    readFile: overrides.readFile ?? ((path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    }),
    env: overrides.env ?? ((name) => process.env[name]),
    home: overrides.home ?? (() => homedir()),
    now: overrides.now ?? (() => performance.now()),
  }
}

/* ------------------------------------------------------------------ *
 *  Credential presence (never returned — only folded into keyPresent).
 * ------------------------------------------------------------------ */

/** Wind key presence: env `WIND_API_KEY` or the `~/.wind-aifinmarket/config` file. */
export function windKeyPresent(seams: HealthSeams): boolean {
  const envValue = seams.env('WIND_API_KEY')
  if (envValue !== undefined && envValue.trim() !== '') return true
  return seams.exists(join(seams.home(), '.wind-aifinmarket', 'config'))
}

/** zyt API key: env `ZYT_API_KEY`, else the `{apiKey}` config file JSON. */
export function zytApiKey(seams: HealthSeams): string | undefined {
  const fromEnv = extractZytApiKey(seams.env('ZYT_API_KEY'))
  if (fromEnv !== undefined) return fromEnv
  return extractZytApiKey(seams.readFile(join(seams.home(), '.config', 'zyt', 'config.json')))
}

/** Beike MCP key candidate files, first hit wins (mirrors the CLI layout). */
const BEIKE_KEY_FILES: readonly string[] = [
  join('.beike', 'BEIKE_MCP_API_KEY'), // resolved against home below
]

/** beike API key: env `BEIKE_MCP_API_KEY`, else the CLI key files. */
export function beikeApiKey(seams: HealthSeams): string | undefined {
  const fromEnv = seams.env('BEIKE_MCP_API_KEY')?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const candidates = [
    ...BEIKE_KEY_FILES.map((rel) => join(seams.home(), rel)),
    '/tmp/beike-cli/.beike/BEIKE_MCP_API_KEY',
  ]
  for (const path of candidates) {
    const raw = seams.readFile(path)?.trim()
    if (raw !== undefined && raw !== '') return raw
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 *  Provider probes.
 * ------------------------------------------------------------------ */

/** Default per-probe HTTP timeout (route contract: 8s). */
export const DEFAULT_HEALTH_TIMEOUT_MS = 8000

/** Bounded health response body (identity/handshake payloads are small). */
const HEALTH_MAX_BODY_BYTES = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Classify a probe failure; timeout vs transport error (message only, no headers). */
function probeErrorDetail(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return `探测超时（${Math.round(timeoutMs / 1000)}s）`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wind probe: filesystem checks only. The CLI is NEVER executed and no quote
 * is requested — health here means "the skill CLI and a credential exist".
 */
export function probeWindHealth(
  input: { readonly registered: boolean; readonly cliPath?: string },
  seams: HealthSeams,
): WindHealth {
  const cliExists = input.cliPath !== undefined && seams.exists(input.cliPath)
  const keyPresent = windKeyPresent(seams)
  let detail: string | undefined
  if (input.cliPath === undefined) detail = '未配置 CLI 路径'
  else if (!cliExists) detail = 'CLI 文件不存在'
  else if (!keyPresent) detail = '未配置凭据（WIND_API_KEY 或 ~/.wind-aifinmarket/config）'
  return {
    registered: input.registered,
    ...(input.cliPath !== undefined ? { cliPath: input.cliPath } : {}),
    cliExists,
    keyPresent,
    ...(detail !== undefined ? { detail } : {}),
  }
}

/**
 * zyt probe: one bounded `GET {baseUrl}/openapi/v1/me` with `X-Api-Key`.
 * Skipped (no socket) when no key resolves — `keyPresent: false` is the
 * whole finding. The key is used in the request header only.
 */
export async function probeZytHealth(
  input: { readonly registered: boolean; readonly baseUrl: string; readonly timeoutMs?: number },
  seams: HealthSeams,
): Promise<ZytHealth> {
  const key = zytApiKey(seams)
  const base = { registered: input.registered, baseUrl: input.baseUrl, keyPresent: key !== undefined }
  if (key === undefined) {
    return { ...base, detail: '未配置凭据（ZYT_API_KEY 或 ~/.config/zyt/config.json）' }
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const started = seams.now()
  try {
    const response = await seams.fetch({
      url: new URL('/openapi/v1/me', input.baseUrl).toString(),
      method: 'GET',
      headers: { 'X-Api-Key': key, accept: 'application/json' },
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      maxBodyBytes: HEALTH_MAX_BODY_BYTES,
    })
    const latencyMs = Math.max(0, Math.round(seams.now() - started))
    const reachable = response.status >= 200 && response.status < 300
    if (!reachable) {
      // Never echo the body: a 4xx/5xx payload may carry server internals.
      return { ...base, reachable, latencyMs, detail: `HTTP ${response.status}` }
    }
    let identity: ZytIdentity | undefined
    try {
      const payload: unknown = JSON.parse(response.body)
      if (isRecord(payload)) {
        const tenantName = stringOf(payload['tenantName'])
        const dataView = stringOf(payload['dataView'])
        if (tenantName !== undefined || dataView !== undefined) {
          identity = { ...(tenantName !== undefined ? { tenantName } : {}), ...(dataView !== undefined ? { dataView } : {}) }
        }
      }
    } catch {
      // Unparseable body: reachable stays true, identity omitted.
    }
    return { ...base, reachable, latencyMs, ...(identity !== undefined ? { identity } : {}) }
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(seams.now() - started))
    return { ...base, reachable: false, latencyMs, detail: probeErrorDetail(error, timeoutMs) }
  }
}

/** First `data:` payload of an SSE body, or the trimmed body itself. */
export function firstSseData(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) return trimmed.slice(5).trim()
  }
  return body.trim()
}

/**
 * beike probe: one bounded MCP `initialize` JSON-RPC POST (protocol
 * 2025-03-26, clientInfo `dsh-health/1.0`), `Authorization: Bearer <key>`,
 * SSE-tolerant response parsing (first `data:` line). Skipped without a key.
 */
export async function probeBeikeHealth(
  input: { readonly registered: boolean; readonly baseUrl: string; readonly timeoutMs?: number },
  seams: HealthSeams,
): Promise<BeikeHealth> {
  const key = beikeApiKey(seams)
  const base = { registered: input.registered, baseUrl: input.baseUrl, keyPresent: key !== undefined }
  if (key === undefined) {
    return { ...base, detail: '未配置凭据（BEIKE_MCP_API_KEY 或 ~/.beike/BEIKE_MCP_API_KEY）' }
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const started = seams.now()
  try {
    const response = await seams.fetch({
      url: input.baseUrl,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dsh-health', version: '1.0' },
        },
      }),
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      maxBodyBytes: HEALTH_MAX_BODY_BYTES,
    })
    const latencyMs = Math.max(0, Math.round(seams.now() - started))
    const reachable = response.status >= 200 && response.status < 300
    if (!reachable) {
      return { ...base, reachable, latencyMs, detail: `HTTP ${response.status}` }
    }
    let serverInfo: string | undefined
    try {
      const payload: unknown = JSON.parse(firstSseData(response.body))
      const result = isRecord(payload) ? payload['result'] : undefined
      const info = isRecord(result) ? result['serverInfo'] : undefined
      if (isRecord(info)) {
        const name = stringOf(info['name'])
        const version = stringOf(info['version'])
        const joined = [name, version].filter((part): part is string => part !== undefined).join(' ')
        if (joined !== '') serverInfo = joined
      }
    } catch {
      // Unparseable handshake: reachable stays true, serverInfo omitted.
    }
    return { ...base, reachable, latencyMs, ...(serverInfo !== undefined ? { serverInfo } : {}) }
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(seams.now() - started))
    return { ...base, reachable: false, latencyMs, detail: probeErrorDetail(error, timeoutMs) }
  }
}

/* ------------------------------------------------------------------ *
 *  Pack drift probe (read-only deterministic digest).
 * ------------------------------------------------------------------ */

/** One pack directory to inspect (absolute path + display label). */
export interface PackDirLike {
  readonly dir: string
  readonly label?: string
}

/** List regular files under `root` as sorted, posix-separated relative paths. */
async function listTreeFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(join(root, prefix === '' ? '.' : prefix), { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await listTreeFiles(root, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Count `*.json` files directly under `<dir>/<section>/` (0 when absent). */
async function countJsonFiles(dir: string, section: string): Promise<number> {
  try {
    const entries = await readdir(join(dir, section), { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
  } catch {
    return 0
  }
}

/**
 * Recompute one pack's deterministic tree digest and compare it against the
 * generator-recorded `generated/pack.sha256`. Read-only: nothing is written.
 *
 * The generator excludes exactly its emitted files from the digest, and every
 * emitted file lives under `generated/` — so excluding the whole `generated/`
 * subtree reproduces the same digest (see scripts/build-*.mjs `generatedFiles`).
 * Drift of generator metadata itself is intentionally out of scope; drift
 * means "the shipped content changed after generation".
 */
export async function probePackHealth(dir: string): Promise<PackHealth> {
  let id = basename(dir)
  let version = ''
  try {
    const meta: unknown = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8'))
    if (isRecord(meta)) {
      id = stringOf(meta['id']) ?? id
      version = stringOf(meta['version']) ?? ''
    }
  } catch {
    // No/invalid pack.json: fall back to the directory name.
  }
  const files = await listTreeFiles(dir)
  const generated = files.filter((rel) => rel.startsWith('generated/'))
  const sha256 = await hashPackageTree(dir, { exclude: generated })
  let reference: string | undefined
  try {
    reference = (await readFile(join(dir, 'generated', 'pack.sha256'), 'utf8')).trim()
  } catch {
    reference = undefined
  }
  const drift: PackDrift = reference === undefined || reference === '' ? 'unknown' : reference === sha256 ? 'clean' : 'dirty'
  return {
    id,
    version,
    experts: await countJsonFiles(dir, 'experts'),
    scenarios: await countJsonFiles(dir, 'scenarios'),
    sha256,
    drift,
  }
}

/* ------------------------------------------------------------------ *
 *  Aggregate probe + single-flight cache + route handler.
 * ------------------------------------------------------------------ */

/** Caller-resolved inputs for one probe run (no secrets). */
export interface HealthProbeInput {
  readonly providers: {
    /** Wind CLI path candidate — present even when unregistered (for display). */
    readonly wind?: { readonly cliPath?: string }
    readonly zyt?: { readonly baseUrl: string }
    readonly beike?: { readonly baseUrl: string }
  }
  /** Provider ids currently registered by the ProviderTransportService. */
  readonly registered: readonly string[]
  /** Pack directories for the `packs` probe. */
  readonly packDirs?: readonly PackDirLike[]
  /** Per-probe HTTP timeout (default {@link DEFAULT_HEALTH_TIMEOUT_MS}). */
  readonly timeoutMs?: number
  /** Seam overrides (tests inject fakes; defaults are the Node seams). */
  readonly seams?: Partial<HealthSeams>
}

/**
 * Run one health probe target. Single-provider targets fully probe that
 * provider (network when keyed) and report the others shallowly (registration
 * + config + credential presence, no sockets); `packs` are listed only for
 * the `packs`/`all` targets.
 */
export async function runHealthProbe(target: HealthProbeTarget, input: HealthProbeInput): Promise<HealthReport> {
  const seams = createNodeHealthSeams(input.seams)
  const registered = new Set(input.registered)
  const deep = (id: 'wind' | 'zyt' | 'beike'): boolean => target === 'all' || target === id

  const wind = probeWindHealth(
    { registered: registered.has('wind'), ...(input.providers.wind?.cliPath !== undefined ? { cliPath: input.providers.wind.cliPath } : {}) },
    seams,
  )

  const zytBase: ZytHealth = {
    registered: registered.has('zyt'),
    baseUrl: input.providers.zyt?.baseUrl ?? '',
    keyPresent: zytApiKey(seams) !== undefined,
  }
  const zyt = deep('zyt') && input.providers.zyt !== undefined
    ? await probeZytHealth(
      { registered: zytBase.registered, baseUrl: zytBase.baseUrl, ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) },
      seams,
    )
    : zytBase

  const beikeBase: BeikeHealth = {
    registered: registered.has('beike'),
    baseUrl: input.providers.beike?.baseUrl ?? '',
    keyPresent: beikeApiKey(seams) !== undefined,
  }
  const beike = deep('beike') && input.providers.beike !== undefined
    ? await probeBeikeHealth(
      { registered: beikeBase.registered, baseUrl: beikeBase.baseUrl, ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) },
      seams,
    )
    : beikeBase

  const packs = target === 'all' || target === 'packs'
    ? await Promise.all((input.packDirs ?? []).map((pack) => probePackHealth(pack.dir)))
    : []

  return {
    checkedAt: new Date().toISOString(),
    providers: { wind, zyt, beike },
    packs,
  }
}

/**
 * 30s in-process probe cache, single-flight per key: concurrent runs share
 * the in-flight promise; settled results serve until the TTL lapses; rejected
 * runs are evicted immediately (failures are never sticky).
 */
export class HealthProbeCache {
  private readonly entries = new Map<string, { readonly promise: Promise<HealthReport>; readonly expiresAt: number }>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(ttlMs = 30_000, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs
    this.now = now
  }

  run(key: string, task: () => Promise<HealthReport>): Promise<HealthReport> {
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.expiresAt > this.now()) return existing.promise
    const promise = task()
    this.entries.set(key, { promise, expiresAt: this.now() + this.ttlMs })
    promise.catch(() => {
      // Evict rejected runs so the next request re-probes.
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key)
    })
    return promise
  }
}

/** Dependencies of the health route handler. */
export interface HealthHandlerDeps {
  /** Resolve fresh probe inputs per run (called through the cache). */
  readonly resolve: () => HealthProbeInput | Promise<HealthProbeInput>
  readonly cache?: HealthProbeCache
}

function isHealthProbeTarget(value: string): value is HealthProbeTarget {
  return (HEALTH_PROBE_TARGETS as readonly string[]).includes(value)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * `GET /plugins/dsh-expert-library/health?probe=<target>` handler. `probe`
 * defaults to `all`; unknown targets are a 400. The response never contains
 * key material — only `keyPresent` booleans and non-secret metadata.
 */
export function createHealthHandler(deps: HealthHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const cache = deps.cache ?? new HealthProbeCache()
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const probeParam = url.searchParams.get('probe') ?? 'all'
    if (!isHealthProbeTarget(probeParam)) {
      sendJson(res, 400, { error: `unknown probe: ${probeParam}` })
      return
    }
    try {
      const report = await cache.run(probeParam, async () => runHealthProbe(probeParam, await deps.resolve()))
      sendJson(res, 200, report)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
