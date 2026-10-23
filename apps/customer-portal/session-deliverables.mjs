import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'

const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,63}$/
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const MEDIA = {
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_ROOT = '/var/lib/zhijian/customer-portal-deliverables'

function scopedDirectory(root, account, sessionId) {
  if (!ACCOUNT.test(account) || !SESSION.test(sessionId)) return undefined
  return join(root, account, sessionId)
}

function documentSummary(row) {
  return { taskId: 'conversation', id: row.id, name: row.name, mediaType: row.mediaType,
    sizeBytes: row.sizeBytes, createdAt: row.createdAt, source: 'conversation',
    resultKey: `conversation:${row.resultKey}`, resultLabel: row.resultLabel, formal: false }
}

/** Only files explicitly published into this private session archive are visible. */
export function createSessionDeliverables(root = DEFAULT_ROOT) {
  async function read(account, sessionId, id) {
    const directory = scopedDirectory(root, account, sessionId)
    if (!directory || !ID.test(id)) return undefined
    try {
      const path = join(directory, `${id}.json`)
      if ((await stat(path)).size > MAX_BYTES * 1.5) return undefined
      const row = JSON.parse(await readFile(path, 'utf8'))
      if (row?.account !== account || row?.sessionId !== sessionId || row?.id !== id
        || typeof row.name !== 'string' || basename(row.name) !== row.name
        || typeof row.resultKey !== 'string' || !ID.test(row.resultKey)
        || typeof row.resultLabel !== 'string' || row.resultLabel.length > 120
        || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.sizeBytes)
        || row.sizeBytes > MAX_BYTES || typeof row.content !== 'string') return undefined
      const extension = row.name.slice(row.name.lastIndexOf('.')).toLowerCase()
      if (row.mediaType !== MEDIA[extension] || Buffer.from(row.content, 'base64').length !== row.sizeBytes) return undefined
      return row
    } catch { return undefined }
  }
  return {
    async list(account, sessionId) {
      const directory = scopedDirectory(root, account, sessionId)
      if (!directory) return []
      let names
      try { names = await readdir(directory) } catch { return [] }
      const rows = await Promise.all(names.filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5)))
        .slice(0, 50).map(name => read(account, sessionId, name.slice(0, -5))))
      return rows.filter(Boolean).map(documentSummary).sort((a, b) => b.createdAt - a.createdAt)
    },
    async document(account, sessionId, taskId, id) {
      if (taskId !== 'conversation') return undefined
      const row = await read(account, sessionId, id)
      return row && { name: row.name, mediaType: row.mediaType, content: row.content, encoding: 'base64' }
    },
  }
}

/** Operator-only publication; the browser and the conversation agent cannot name arbitrary workspace paths. */
export async function publishSessionDeliverable({ root = DEFAULT_ROOT, account, sessionId, id, resultKey, resultLabel, workspace, source }) {
  const directory = scopedDirectory(root, account, sessionId)
  if (!directory || !ID.test(id) || !ID.test(resultKey) || typeof resultLabel !== 'string'
    || !resultLabel.trim() || resultLabel.length > 120) throw Error('INVALID_DELIVERABLE_SCOPE')
  const workspacePath = await realpath(workspace)
  const sourcePath = await realpath(source)
  if (!sourcePath.startsWith(workspacePath + sep)) throw Error('DELIVERABLE_OUTSIDE_WORKSPACE')
  const name = basename(sourcePath)
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (!MEDIA[extension]) throw Error('DELIVERABLE_TYPE_UNSUPPORTED')
  const info = await stat(sourcePath)
  if (!info.isFile() || info.size > MAX_BYTES) throw Error('DELIVERABLE_TOO_LARGE')
  const content = await readFile(sourcePath)
  const row = { account, sessionId, id, resultKey, resultLabel: resultLabel.trim(),
    name, mediaType: MEDIA[extension], sizeBytes: content.length, createdAt: Date.now(), content: content.toString('base64') }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${id}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(row), { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(directory, `${id}.json`))
  } catch (error) { await rm(temporary, { force: true }); throw error }
  return documentSummary(row)
}
