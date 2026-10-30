import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

const SESSION = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const MAX_BYTES = 8 * 1024 * 1024
const MEDIA: Record<string, string> = {
  '.md': 'text/markdown', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

interface Artifact {
  sessionId: string
  id: string
  name: string
  resultKey: string
  resultLabel: string
  mediaType: string
  sizeBytes: number
  sha256: string
  createdAt: number
  content: string
}

export function createCustomerArtifacts(home: string, workspace: string) {
  const archive = join(home, 'customer-artifacts')
  const directory = (sessionId: string) => {
    if (!SESSION.test(sessionId)) throw new Error('INVALID_SESSION')
    return join(archive, sessionId)
  }
  async function read(sessionId: string, id: string): Promise<Artifact | undefined> {
    if (!SESSION.test(sessionId) || !ID.test(id)) return undefined
    try {
      const path = join(directory(sessionId), `${id}.json`)
      if ((await stat(path)).size > MAX_BYTES * 1.5) return undefined
      const row = JSON.parse(await readFile(path, 'utf8')) as Artifact
      if (row.sessionId !== sessionId || row.id !== id || basename(row.name) !== row.name
        || !ID.test(row.resultKey) || !row.resultLabel || row.resultLabel.length > 120
        || row.mediaType !== MEDIA[extname(row.name).toLowerCase()]
        || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.sizeBytes)
        || row.sizeBytes < 1 || row.sizeBytes > MAX_BYTES || typeof row.content !== 'string'
        || Buffer.from(row.content, 'base64').length !== row.sizeBytes
        || (row.sha256 !== undefined && (!/^[a-f0-9]{64}$/.test(row.sha256)
          || createHash('sha256').update(Buffer.from(row.content, 'base64')).digest('hex') !== row.sha256))) return undefined
      return row
    } catch { return undefined }
  }
  return {
    async publish(sessionId: string, source: string, resultKey: string, resultLabel: string, sessionWorkspace = workspace) {
      if (!SESSION.test(sessionId) || !ID.test(resultKey) || !resultLabel.trim() || resultLabel.length > 120)
        throw new Error('INVALID_ARTIFACT_METADATA')
      const accountRoot = await realpath(workspace)
      const root = await realpath(sessionWorkspace)
      if (root !== accountRoot && !root.startsWith(join(accountRoot, 'spaces') + sep))
        throw new Error('ARTIFACT_OUTSIDE_WORKSPACE')
      const file = await realpath(resolve(root, source))
      if (!file.startsWith(root + sep) || file.startsWith(join(root, 'customer-uploads') + sep))
        throw new Error('ARTIFACT_OUTSIDE_WORKSPACE')
      const name = basename(file)
      const extension = extname(name).toLowerCase()
      if (!MEDIA[extension]) throw new Error('ARTIFACT_TYPE_UNSUPPORTED')
      const info = await stat(file)
      if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw new Error('ARTIFACT_SIZE_INVALID')
      const bytes = await readFile(file)
      if (extension === '.pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
        || extension === '.docx' && (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
          || !bytes.includes(Buffer.from('word/document.xml')))) throw new Error('ARTIFACT_CONTENT_INVALID')
      const id = randomUUID()
      const publicOrigin = process.env.DSH_CUSTOMER_PORTAL_ORIGIN ?? 'https://zhijian.meizu.life'
      if (!/^https:\/\/[^/]+$/.test(publicOrigin)) throw new Error('INVALID_CUSTOMER_PORTAL_ORIGIN')
      const row: Artifact = { sessionId, id, name, resultKey, resultLabel: resultLabel.trim(),
        mediaType: MEDIA[extension], sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: Date.now(), content: bytes.toString('base64') }
      const target = directory(sessionId)
      await mkdir(target, { recursive: true, mode: 0o700 })
      const temporary = join(target, `.${id}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(row), { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(target, `${id}.json`))
      } finally { await rm(temporary, { force: true }) }
      const downloadPath = `/api/sessions/${sessionId.slice(8)}/workspace/documents/conversation/${id}/download`
      return { taskId: 'conversation', id, name, resultKey: `conversation:${resultKey}`,
        resultLabel: row.resultLabel, downloadPath, downloadUrl: `${publicOrigin}${downloadPath}` }
    },
    async list(sessionId: string) {
      if (!SESSION.test(sessionId)) return []
      const files = await readdir(directory(sessionId)).catch(() => [])
      const rows = await Promise.all(files.filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5)))
        .slice(-100).map(name => read(sessionId, name.slice(0, -5))))
      return rows.filter((row): row is Artifact => !!row).map(row => ({ taskId: 'conversation', id: row.id,
        name: row.name, mediaType: row.mediaType, sizeBytes: row.sizeBytes, createdAt: row.createdAt,
        source: 'conversation', resultKey: `conversation:${row.resultKey}`, resultLabel: row.resultLabel, formal: false }))
        .sort((a, b) => b.createdAt - a.createdAt)
    },
    async document(sessionId: string, taskId: string, id: string) {
      if (taskId !== 'conversation') return undefined
      const row = await read(sessionId, id)
      return row && { document: { name: row.name, mediaType: row.mediaType, content: row.content, encoding: 'base64' } }
    },
  }
}

export function registerCustomerArtifactTool(ctx: Context, workspace: string, artifacts: ReturnType<typeof createCustomerArtifacts>) {
  ctx.tools.register(defineTool({
    name: 'customer_publish_document',
    description: '客户会话报告生成并检查通过后，将工作空间内的 DOCX、PDF 或 Markdown 登记为当前会话的私有可下载成果。返回的下载路径由门户鉴权。银行房产报告必须登记真实 DOCX 后再告诉用户可下载。',
    parameters: {
      file: { type: 'string', required: true, description: '已生成文件在客户工作空间内的相对路径' },
      resultKey: { type: 'string', required: true, description: '任务 ID 或同一组成果的短标识；同组不同格式使用同一值' },
      resultLabel: { type: 'string', required: true, description: '成果展示名称' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      taskId: { type: 'string', required: true }, id: { type: 'string', required: true },
      name: { type: 'string', required: true }, resultKey: { type: 'string', required: true },
      resultLabel: { type: 'string', required: true }, downloadPath: { type: 'string', required: true },
      downloadUrl: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agent = exec.agent
      const cwd = agent?.session.header.cwd
      const root = await realpath(workspace)
      const actual = cwd ? await realpath(cwd) : ''
      if (!agent || agent.session.header.origin === 'subagent'
        || (actual !== root && !actual.startsWith(join(root, 'spaces') + sep))) throw new Error('ARTIFACT_NOT_CUSTOMER_SESSION')
      return artifacts.publish(agent.session.header.id, args.file, args.resultKey, args.resultLabel, actual)
    },
  }))
}
