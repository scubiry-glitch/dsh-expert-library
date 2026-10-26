import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, realpath } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

export type UsageKind = 'expert' | 'skill' | 'pack' | 'source'
const SESSION = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID = /^[\p{L}\p{N}._:-]{1,128}$/u
const DAY = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const KINDS: UsageKind[] = ['expert', 'skill', 'pack', 'source']

export interface CustomerUsageEvent {
  kind: UsageKind
  id: string
  sessionId: string
  workspace: string
  version?: string
  /** Stable for a material delivery; prevents repeat claims counting twice. */
  occurrence?: string
}

function configured() {
  const home = process.env['DSH_HOME']
  const workspace = process.env['DSH_CUSTOMER_WORKSPACE_DIR']
  return home && workspace ? { home, workspace } : undefined
}

/** A dedicated DSH_HOME is the tenant boundary. No question or response text is stored. */
export async function recordCustomerUsage(event: CustomerUsageEvent): Promise<void> {
  const scope = configured()
  if (!scope) return
  if (!KINDS.includes(event.kind) || !ID.test(event.id) || !SESSION.test(event.sessionId)
    || (event.version !== undefined && !ID.test(event.version))
    || (event.occurrence !== undefined && !ID.test(event.occurrence))) return
  if (await realpath(event.workspace) !== await realpath(scope.workspace)) return
  const at = Date.now()
  const dir = join(scope.home, 'customer-usage')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await appendFile(join(dir, `${new Date(at).toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify({ at, kind: event.kind, id: event.id, sessionId: event.sessionId,
      ...(event.version ? { version: event.version } : {}),
      ...(event.occurrence ? { occurrence: event.occurrence } : {}) })}\n`, { mode: 0o600 })
}

export async function readCustomerUsage(home: string, days: 7 | 30 = 7, now = Date.now()) {
  const dir = join(home, 'customer-usage')
  const cutoff = now - days * 86_400_000
  const until = now + 60_000
  const groups = Object.fromEntries(KINDS.map(kind => [kind, new Map<string, {
    id: string; version?: string; calls: number; sessions: Set<string>
  }>()])) as Record<UsageKind, Map<string, { id: string; version?: string; calls: number; sessions: Set<string> }>>
  let files: string[] = []
  try { files = (await readdir(dir)).filter(name => DAY.test(name) && name.slice(0, 10) >= new Date(cutoff).toISOString().slice(0, 10)).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let firstEventAt: number | null = null
  const seen = new Set<string>()
  for (const name of files) {
    const lines = createInterface({ input: createReadStream(join(dir, name), { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      if (line.length > 1024) continue
      let item: Record<string, unknown>
      try { item = JSON.parse(line) as Record<string, unknown> } catch { continue }
      if (!KINDS.includes(item.kind as UsageKind) || typeof item.id !== 'string' || !ID.test(item.id)
        || typeof item.sessionId !== 'string' || !SESSION.test(item.sessionId)
        || typeof item.at !== 'number' || item.at < cutoff || item.at > until) continue
      const kind = item.kind as UsageKind
      const version = typeof item.version === 'string' && ID.test(item.version) ? item.version : undefined
      const occurrence = typeof item.occurrence === 'string' && ID.test(item.occurrence) ? item.occurrence : undefined
      const dedupe = occurrence === undefined ? undefined : `${kind}:${item.id}:${item.sessionId}:${occurrence}`
      if (dedupe && seen.has(dedupe)) continue
      if (dedupe) seen.add(dedupe)
      firstEventAt = Math.min(firstEventAt ?? item.at, item.at)
      const key = `${item.id}\u0000${version ?? ''}`
      let row = groups[kind].get(key)
      if (!row) { row = { id: item.id, ...(version ? { version } : {}), calls: 0, sessions: new Set() }; groups[kind].set(key, row) }
      row.calls++
      row.sessions.add(item.sessionId)
    }
  }
  const rankings = Object.fromEntries(KINDS.map(kind => [kind, [...groups[kind].values()]
    .map(row => ({ id: row.id, ...(row.version ? { version: row.version } : {}), calls: row.calls, sessions: row.sessions.size }))
    .sort((a, b) => b.calls - a.calls || b.sessions - a.sessions || a.id.localeCompare(b.id, 'zh-CN')).slice(0, 20)]))
  return { days, asOf: now, firstEventAt, rankings }
}
