import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const JOB = /^rv2-[0-9a-f]{24}$/
const ROLES = ['price_full', 'price_external', 'rent_full', 'rent_external']
const FILE = /^(price_full|price_external|rent_full|rent_external)-([0-9a-f]{12})$/
const LINK = /\]\(\/api\/residential-v2\/files\/(rv2-[0-9a-f]{24})\/((?:price_full|price_external|rent_full|rent_external)-[0-9a-f]{12})\)/g
const ROOT = '/var/lib/zhijian/customer-portal/residential-demo-index'

const steps = [
  '校验脱敏标的并绑定福州冻结资源',
  '运行住宅价格模型，保留价格快照',
  '运行住宅租金模型，保留租金快照',
  '提交价格与租金四角色 Word 生成任务',
  '查询任务并核对四份原始文件',
  '完成机器检查并交付演示附件',
]
const chapters = [
  '咨询报告声明', '咨询基本事项', '咨询假设',
  '测算方法及测算过程', '咨询结论及重要提示', '咨询报告的附件',
]
const baseView = { kind: 'fuzhou-golden-demo', packVersion: '0.3.0', steps, chapters }
const demoRequest = message => message?.role === 'user' && typeof message.text === 'string'
  && /福州/.test(message.text) && /(四报告|四份.{0,12}(?:Word|DOCX|报告))/i.test(message.text)
  && /(演示|脱敏|黄金样例)/.test(message.text)

function linkedJob(message) {
  if (message?.role !== 'assistant' || typeof message.text !== 'string') return undefined
  const grouped = new Map()
  for (const match of message.text.matchAll(LINK)) {
    const [, jobId, fileId] = match
    if (!grouped.has(jobId)) grouped.set(jobId, new Map())
    grouped.get(jobId).set(fileId.split('-')[0], fileId)
  }
  for (const [jobId, files] of [...grouped].reverse()) {
    if (ROLES.every(role => FILE.test(files.get(role) ?? ''))) return { jobId, files }
  }
  return undefined
}

function validMetadata(value, linked) {
  if (!value || value.job_id !== linked.jobId || value.status !== 'succeeded'
    || value.quality_status !== 'passed' || value.release_id !== 'fz_single_property_toolkit_20261008_v2'
    || !Array.isArray(value.files) || value.files.length !== 4) return false
  const rows = new Map(value.files.map(item => [item?.role, item]))
  return ROLES.every(role => {
    const item = rows.get(role)
    const fileMatch = FILE.exec(item?.file_id ?? '')
    return fileMatch?.[1] === role && linked.files.get(role) === item.file_id
      && typeof item.filename === 'string' && item.filename.endsWith('.docx')
      && Number.isSafeInteger(item.size_bytes) && item.size_bytes > 0 && item.size_bytes <= 20 * 1024 * 1024
      && /^[0-9a-f]{64}$/.test(item.sha256 ?? '') && item.sha256.startsWith(fileMatch[2])
  })
}

/** Backfill a C session from its durable assistant links, then verify the actual demo job. */
export function createResidentialDemoWorkspace({ root = ROOT, fetcher = fetch } = {}) {
  async function load(sessionId) {
    try {
      const item = JSON.parse(await readFile(join(root, `${sessionId}.json`), 'utf8'))
      return item.sessionId === sessionId && Number.isSafeInteger(item.cursor) && item.cursor >= -1
        && (!item.jobId || JOB.test(item.jobId)) ? item : { sessionId, cursor: -1 }
    } catch { return { sessionId, cursor: -1 } }
  }
  async function save(item) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = join(root, `${item.sessionId}.json`)
    const temporary = join(root, `.${item.sessionId}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(item), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  }
  return {
    async forSession({ backendRef, shareId, sessionId, runtime, gateway }) {
      if (backendRef !== 'zhijian-demo-c' || shareId || !SESSION.test(sessionId)) return undefined
      const item = await load(sessionId)
      let linked
      try {
        for (let page = 0; page < 10; page++) {
          const result = await gateway.conversation(runtime, `session-${sessionId}`, item.cursor)
          for (const message of result.messages ?? []) {
            if (demoRequest(message)) item.intent = true
            linked = linkedJob(message) ?? linked
          }
          if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor <= item.cursor) break
          item.cursor = result.nextCursor
          if (linked) item.jobId = linked.jobId
          if (!result.hasMore) break
        }
        if (linked) item.files = Object.fromEntries(linked.files)
        await save(item)
      } catch { /* Keep the last verified receipt when conversation is temporarily unavailable. */ }
      const pending = item.intent ? { ...baseView, status: 'pending', files: [] } : undefined
      if (!item.jobId || !JOB.test(item.jobId)) return pending
      const expected = { jobId: item.jobId, files: new Map(Object.entries(item.files ?? {})) }
      if (!ROLES.every(role => FILE.test(expected.files.get(role) ?? ''))) return pending
      try {
        const response = await fetcher(`http://127.0.0.1:8793/internal-jobs/${item.jobId}`,
          { signal: AbortSignal.timeout(5_000), redirect: 'manual', cache: 'no-store' })
        if (!response.ok) return pending
        const job = await response.json()
        if (!validMetadata(job, expected)) return pending
        return { ...baseView, status: 'succeeded',
          jobId: item.jobId, completedAt: job.completed_at,
          files: ROLES.map(role => {
            const file = job.files.find(row => row.role === role)
            return { role, name: file.filename, sizeBytes: file.size_bytes, sha256: file.sha256,
              href: `/api/residential-v2/files/${item.jobId}/${file.file_id}` }
          }) }
      } catch { return pending }
    },
  }
}
