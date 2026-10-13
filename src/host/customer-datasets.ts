import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNAPSHOT = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BYTES = 8 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export interface CustomerDatasetCapture {
  sessionId: string
  workspace: string
  configuredWorkspace: string
  dataset: string
  version: string
  signature: string
  provider: string
  provenance: Record<string, unknown>
  data: unknown
}

/** Only the validated provider tool writes snapshots; the agent workspace is not the store. */
export async function saveCustomerDataset(home: string, capture: CustomerDatasetCapture): Promise<string> {
  if (!SESSION.test(capture.sessionId) || !capture.dataset || !capture.version || !capture.signature || !capture.provider
    || await realpath(capture.workspace) !== await realpath(capture.configuredWorkspace)) throw Error('CUSTOMER_DATA_SCOPE_INVALID')
  const id = `${Date.now().toString().padStart(13, '0')}-${randomUUID()}`
  const directory = join(home, 'customer-data', capture.sessionId)
  const snapshot = {
    id, sessionId: capture.sessionId, dataset: capture.dataset, version: capture.version,
    signature: capture.signature, provider: capture.provider, at: Date.now(),
    provenance: capture.provenance, data: capture.data,
  }
  const bytes = Buffer.from(JSON.stringify(snapshot))
  if (bytes.length > MAX_BYTES) throw Error('CUSTOMER_DATA_TOO_LARGE')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${id}.tmp`)
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(directory, `${id}.json`))
  } catch (error) { await rm(temporary, { force: true }); throw error }
  return id
}

async function snapshotFile(home: string, sessionId: string, id: string): Promise<Record<string, unknown> | undefined> {
  if (!SESSION.test(sessionId) || !SNAPSHOT.test(id)) return undefined
  try {
    const raw = await readFile(join(home, 'customer-data', sessionId, `${id}.json`))
    if (raw.length > MAX_BYTES) return undefined
    const value: unknown = JSON.parse(raw.toString('utf8'))
    return record(value) && value.id === id && value.sessionId === sessionId ? value : undefined
  } catch { return undefined }
}

function publicSummary(row: Record<string, unknown>) {
  const provenance = record(row.provenance) ? row.provenance : {}
  return { id: row.id, dataset: row.dataset, version: row.version, signature: row.signature,
    provider: row.provider, at: row.at,
    source: row.provider, caliber: typeof provenance.caliber === 'string' ? provenance.caliber : undefined,
    unit: typeof provenance.unit === 'string' ? provenance.unit : undefined }
}

export async function listCustomerDatasets(home: string, sessionId: string, before?: string) {
  if (!SESSION.test(sessionId) || (before !== undefined && !SNAPSHOT.test(before))) throw Error('INVALID_CURSOR')
  let names: string[]
  try { names = await readdir(join(home, 'customer-data', sessionId)) } catch { return { items: [], nextCursor: undefined, hasMore: false } }
  const ids = names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    .filter(id => SNAPSHOT.test(id) && (before === undefined || id < before)).sort().reverse()
  const items = []
  for (const id of ids) {
    const row = await snapshotFile(home, sessionId, id)
    if (row) items.push(publicSummary(row))
    if (items.length === 50) break
  }
  return { items, nextCursor: items.length === 50 ? items[items.length - 1]?.id : undefined,
    hasMore: ids.length > 50 }
}

function tableOf(data: unknown): { columns: string[]; rows: unknown[][] } {
  let value = data
  for (let depth = 0; depth < 3 && record(value) && (record(value.data) || Array.isArray(value.data)); depth++) value = value.data
  if (record(value) && Array.isArray(value.columns) && Array.isArray(value.rows)) {
    const columns = value.columns.map(String)
    return { columns, rows: value.rows.filter(Array.isArray).map(row => columns.map((_, index) => row[index] ?? null)) }
  }
  if (record(value)) value = value.series ?? value.list ?? value.entries ?? value.rows ?? value
  if (Array.isArray(value)) {
    const objects = value.filter(record)
    if (objects.length === value.length) {
      const columns = [...new Set(objects.flatMap(item => Object.keys(item)))].slice(0, 80)
      return { columns, rows: objects.map(item => columns.map(column => item[column] ?? null)) }
    }
    return { columns: ['值'], rows: value.map(item => [item]) }
  }
  if (record(value)) return { columns: ['字段', '值'], rows: Object.entries(value).map(([key, item]) => [key, item]) }
  return { columns: ['值'], rows: [[value]] }
}

export async function readCustomerDataset(home: string, sessionId: string, id: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('INVALID_CURSOR')
  const row = await snapshotFile(home, sessionId, id)
  if (!row) return undefined
  const table = tableOf(row.data)
  return { ...publicSummary(row), columns: table.columns, rows: table.rows.slice(offset, offset + 100),
    totalRows: table.rows.length, nextOffset: offset + 100 < table.rows.length ? offset + 100 : undefined }
}
