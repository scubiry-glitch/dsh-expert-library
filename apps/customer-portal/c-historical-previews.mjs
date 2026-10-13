import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const entries = Object.freeze([
  { folder: 'chengdu', id: 'dd2c8815-287c-4bcf-8925-e9cb76ebc747',
    teamId: '智见报告-成都数据集团合作', captainSessionId: 'session-aec3fc2a-285d-4c57-b987-901ac5a3d58b',
    sourceFile: '20260905-cddg-coop-report-v2-designer.html', createdAt: 1788602309963 },
  { folder: 'roles', id: '8a3d657f-335c-40ad-aafc-41c6ff465f29',
    teamId: '智见点评-十二主体角色重写', captainSessionId: 'session-6d6dad49-4b0f-4e9a-afb1-ba3dba1a684e',
    sourceFile: 'role-rewrite-12-v54.html', createdAt: 1787986357249 },
  { folder: 'haixing', id: 'e1e6186d-8600-4a2f-8be5-f503b6964d57',
    teamId: '智见点评-海兴雅苑一居室租金定价', captainSessionId: 'session-397808a7-36a6-45c5-8572-606524ca54fa',
    sourceFile: 'rent-pricing.html', createdAt: 1789611729744, reportScripts: true },
])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Original captain sessions, projected as immutable snapshots under account C. */
export function createCustomerHistoricalPreviews(root = new URL('./private-previews/original-sessions/', import.meta.url)) {
  return entries.map(entry => {
    const folder = new URL(`${entry.folder}/`, root)
    const visible = principal => principal?.slug === 'zhijian' && principal?.backendRef === 'zhijian-demo-c'
    const load = async () => {
      const [manifest, workspace, messages, html] = await Promise.all([
        readFile(new URL('manifest.json', folder), 'utf8').then(JSON.parse),
        readFile(new URL('workspace.json', folder)),
        readFile(new URL('messages.json', folder)),
        readFile(new URL('report.html', folder)),
      ])
      if (manifest?.version !== 1 || manifest.kind !== 'original-session' || manifest.session?.id !== entry.id
        || manifest.teamId !== entry.teamId || manifest.captainSessionId !== entry.captainSessionId
        || manifest.report?.name !== entry.sourceFile || manifest.sourceFile !== entry.sourceFile
        || manifest.report?.mediaType !== 'text/html'
        || !Number.isSafeInteger(manifest.report.sizeBytes) || manifest.report.sizeBytes !== html.length
        || manifest.report.sha256 !== digest(html) || manifest.workspaceSha256 !== digest(workspace)
        || manifest.messagesSha256 !== digest(messages)) throw new Error('historical preview manifest invalid')
      const state = JSON.parse(workspace)
      const conversation = JSON.parse(messages)
      if (state.team?.id !== entry.teamId || state.team?.captainSessionId !== entry.captainSessionId
        || state.preview?.kind !== 'external-read-only' || state.preview?.source !== 'original-session'
        || (state.preview?.reportScripts === true) !== (entry.reportScripts === true)
        || !Array.isArray(state.documents) || state.documents.length !== 1
        || state.documents[0].taskId !== manifest.report.taskId || state.documents[0].id !== manifest.report.id
        || state.documents[0].name !== manifest.report.name || !Array.isArray(conversation)
        || !conversation.every((item, index) => item.seq === index && ['user', 'assistant'].includes(item.role)
          && typeof item.text === 'string' && Number.isSafeInteger(item.time))) throw new Error('historical preview invalid')
      return { manifest, state, conversation, html }
    }
    return {
      session: Object.freeze({ id: entry.id, title: entry.teamId, createdAt: entry.createdAt,
        preview: true, previewKind: 'historical-session' }),
      visible,
      available: async () => load().then(() => true, () => false),
      workspace: async () => (await load()).state,
      messages: async (after, latest = false, before = Number.MAX_SAFE_INTEGER) => {
        const rows = (await load()).conversation
        if (latest) {
          const eligible = rows.filter(item => item.seq < before)
          const page = eligible.slice(-30)
          return { messages: page, nextCursor: before === Number.MAX_SAFE_INTEGER ? rows.at(-1)?.seq ?? -1 : after,
            hasMore: false, hasEarlier: eligible.length > page.length, turnFailures: [] }
        }
        const page = rows.filter(item => item.seq > after).slice(0, 50)
        const nextCursor = page.at(-1)?.seq ?? Math.max(after, 0)
        return { messages: page, nextCursor, hasMore: rows.some(item => item.seq > nextCursor), turnFailures: [] }
      },
      document: async (taskId, artifactId) => {
        const { manifest, html } = await load()
        if (taskId !== manifest.report.taskId || artifactId !== manifest.report.id) return undefined
        return { name: manifest.report.name, mediaType: 'text/html', content: html.toString('utf8') }
      },
      allowsScripts: artifactId => entry.reportScripts === true && artifactId === 'source-html',
    }
  })
}
