/**
 * Provider-call audit persistence + read surface (audit gap #2 fix).
 *
 * The registry keeps an in-memory audit trail of every invoke (`src/v2/
 * provider-runtime.ts` `recordAudit`) and `ProviderTransportService.audit()`
 * exposes it — but nothing read it and it died with the process. This module
 * closes the loop with three pieces:
 *
 * 1. {@link AuditLogFile} — append-only JSONL persistence for invoke audit
 *    records, one JSON object per line, capped by rotation at ~5MB (keep the
 *    last N lines). All writes are asynchronous and fire-and-forget from the
 *    caller's side; the log is best-effort and must never break a provider
 *    call.
 * 2. {@link createAuditHandler} — the `GET /plugins/dsh-expert-library/audit`
 *    route handler: merges the persisted tail (the cross-restart memory) with
 *    the live in-memory registry audit (first-class), dedupes by record
 *    identity, and returns the merged tail bounded by `?limit=` (default 100,
 *    max 500). The wire projection copies exactly the audit fields
 *    (kind/providerId/version/operation/outcome/at + detail) — nothing else,
 *    so credentials can never ride along.
 * 3. {@link resolveAuditLogPath} — where the log lives: under the DSH data
 *    dir when `DSH_HOME` is set (the harness's data-dir convention — agent
 *    presets live under `${DSH_HOME:-$HOME/.dsh}`), else
 *    `<process.cwd()>/.expert-teams/provider-audit.jsonl`.
 *
 * Design decisions (documented per the audit-gap fix):
 * - The log file is **process-wide**, not per-workspace: provider calls are a
 *   host-plane concern and team state (`stateDir`) is per-workspace — the
 *   DSH_HOME/cwd location keeps one log per host without coupling to any
 *   workspace.
 * - The file records **only `invoke` entries** (the task's "each invoke audit
 *   record"); register/attach/replace lifecycle events stay in the in-memory
 *   registry audit where they are observable live.
 * - Rotation keeps the last {@link AUDIT_LOG_KEEP_LINES} lines once the file
 *   exceeds {@link AUDIT_LOG_MAX_BYTES}; with ~200-byte records that is
 *   roughly 4MB of history per 5MB cap.
 * - Writes are serialized through an internal promise queue and errors are
 *   swallowed by the caller with `logger.warn` — a failing audit log never
 *   fails a provider call.
 *
 * @module dsh-expert-library/host/audit-log
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { RegistryAuditEntry, RegistryAuditKind } from '../v2/provider-runtime.ts'
import type { DroppedSessionEvents } from '../events.ts'

/** Default tail length of the audit route (`?limit=` default). */
export const DEFAULT_AUDIT_LIMIT = 100
/** Hard cap on the audit route tail length. */
export const MAX_AUDIT_LIMIT = 500
/** Rotation cap: the JSONL log is rewritten once it exceeds ~5MB. */
export const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024
/** Rotation keeps the last N lines (≈4MB of ~200-byte records under the 5MB cap). */
export const AUDIT_LOG_KEEP_LINES = 20_000

/** Options of {@link AuditLogFile} (tests shrink the rotation knobs). */
export interface AuditLogOptions {
  readonly maxBytes?: number
  readonly keepLines?: number
}

/** Wire shape of one audit entry (exact registry fields, nothing else). */
export interface AuditWireEntry {
  readonly at: string
  readonly kind: RegistryAuditKind
  readonly providerId: string
  readonly version: string
  readonly detail?: string
  readonly operation?: string
  readonly outcome?: 'ok' | 'fail'
}

/**
 * Append-only JSONL audit log. Writes are queued (serialized) and best-effort:
 * `appendAll` resolves/rejects with the write outcome so the caller can log a
 * warn, and the internal queue self-heals so one failure never wedges later
 * appends.
 */
export class AuditLogFile {
  private queue: Promise<void> = Promise.resolve()
  private readonly maxBytes: number
  private readonly keepLines: number

  constructor(
    private readonly path: string,
    options: AuditLogOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? AUDIT_LOG_MAX_BYTES
    this.keepLines = options.keepLines ?? AUDIT_LOG_KEEP_LINES
  }

  /** Absolute path of the log file (exposed for tests/diagnostics). */
  get filePath(): string {
    return this.path
  }

  /**
   * Append entries as one JSON line each, then rotate if the file exceeds the
   * cap. Serialized with previously queued appends. Never called on the
   * provider invoke path synchronously — callers fire-and-forget and catch.
   */
  appendAll(entries: readonly unknown[]): Promise<void> {
    const task = async (): Promise<void> => {
      if (entries.length === 0) return
      await mkdir(dirname(this.path), { recursive: true })
      const lines = entries.map((entry) => JSON.stringify(entry)).join('\n')
      await appendFile(this.path, `${lines}\n`, 'utf8')
      await this.rotateIfNeeded()
    }
    this.queue = this.queue.catch(() => undefined).then(task)
    return this.queue
  }

  /** Resolve when every queued append has settled (tests; ignored failures). */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * Read the last `limit` parsed entries. A missing/unreadable file is `[]`;
   * malformed lines (partial write, manual edit) are skipped.
   */
  async readTail(limit: number): Promise<RegistryAuditEntry[]> {
    try {
      const text = await readFile(this.path, 'utf8')
      const lines = text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const out: RegistryAuditEntry[] = []
      for (const line of lines.slice(-limit)) {
        try {
          const parsed: unknown = JSON.parse(line)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            out.push(parsed as RegistryAuditEntry)
          }
        } catch {
          // malformed line — skip
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** Rewrite the file keeping the last `keepLines` lines once it exceeds the cap. */
  private async rotateIfNeeded(): Promise<void> {
    let info
    try {
      info = await stat(this.path)
    } catch {
      return
    }
    if (info.size <= this.maxBytes) return
    const text = await readFile(this.path, 'utf8')
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const kept = lines.slice(-this.keepLines)
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
    await rename(tmp, this.path)
  }
}

/**
 * Resolve the provider-audit log path: `<DSH_HOME>/.expert-teams/
 * provider-audit.jsonl` when `DSH_HOME` is set (the DSH data dir), else
 * `<cwd>/.expert-teams/provider-audit.jsonl`. `env`/`cwd` are injectable for
 * tests.
 */
export function resolveAuditLogPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): string {
  const dshHome = env['DSH_HOME']
  const base = dshHome !== undefined && dshHome.trim() !== '' ? dshHome : cwd
  return join(base, '.expert-teams', 'provider-audit.jsonl')
}

/**
 * Parse the `?limit=` query value: absent/invalid/non-positive → the default
 * (100); anything above {@link MAX_AUDIT_LIMIT} clamps to 500.
 */
export function parseAuditLimit(raw: string | null, fallback = DEFAULT_AUDIT_LIMIT): number {
  if (raw === null || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, MAX_AUDIT_LIMIT)
}

/** Project a registry entry to its wire shape (only the documented fields). */
function toWireEntry(entry: RegistryAuditEntry): AuditWireEntry {
  return {
    at: entry.at,
    kind: entry.kind,
    providerId: entry.providerId,
    version: entry.version,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.operation !== undefined ? { operation: entry.operation } : {}),
    ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
  }
}

/**
 * Merge the persisted file tail (cross-restart memory) with the in-memory
 * registry audit (first-class), deduped by exact record identity (the file
 * contains copies of this process's own entries, which must not double-count),
 * sorted by `at`, and bounded to the last `limit` entries.
 */
export function mergeAuditTails(
  fileTail: readonly RegistryAuditEntry[],
  memoryTail: readonly RegistryAuditEntry[],
  limit: number,
): AuditWireEntry[] {
  const memoryKeys = new Set(memoryTail.map((entry) => JSON.stringify(entry)))
  const merged: RegistryAuditEntry[] = [
    ...fileTail.filter((entry) => !memoryKeys.has(JSON.stringify(entry))),
    ...memoryTail,
  ]
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return merged.slice(-limit).map(toWireEntry)
}

/** Dependencies of the audit route handler. */
export interface AuditHandlerDeps {
  /** The persisted JSONL log; omitted/absent file → in-memory only. */
  readonly auditLog?: AuditLogFile
  /** Resolve the live in-memory audit entries (registry's audit log). */
  readonly resolveMemory: () => readonly RegistryAuditEntry[]
  /**
   * Optional live snapshot of dropped session events (the closed session
   * vocabulary in `src/events.ts`): when provided, the response also carries
   * `eventsDropped: { total, byType }` so `expert-teams/*` session events the
   * harness cannot durably record are observable instead of silent.
   */
  readonly resolveDroppedEvents?: () => DroppedSessionEvents
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * `GET /plugins/dsh-expert-library/audit?limit=<n>` handler. `limit` defaults
 * to 100 and clamps at 500. The response is `{ entries: AuditWireEntry[] }` —
 * the registry audit tail merged with the persisted JSONL tail (last `limit`
 * lines of each), deduped by record identity, in `at` order. Entries carry
 * only kind/providerId/version/operation/outcome/at + detail: credentials
 * never appear (registry records never contain them and the wire projection
 * copies only those fields). When {@link AuditHandlerDeps.resolveDroppedEvents}
 * is provided, the response additionally carries `eventsDropped`
 * ({@link DroppedSessionEvents}) — dropped `expert-teams/*` session events.
 */
export function createAuditHandler(deps: AuditHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const limit = parseAuditLimit(url.searchParams.get('limit'))
      const memory = deps.resolveMemory().slice(-limit)
      const fileTail = deps.auditLog === undefined ? [] : await deps.auditLog.readTail(limit)
      const entries = mergeAuditTails(fileTail, memory, limit)
      const body: Record<string, unknown> = { entries }
      if (deps.resolveDroppedEvents !== undefined) {
        body['eventsDropped'] = deps.resolveDroppedEvents()
      }
      sendJson(res, 200, body)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
