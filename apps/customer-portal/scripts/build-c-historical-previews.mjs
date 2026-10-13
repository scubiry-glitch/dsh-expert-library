import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { teamToWire, planToWire } from '../../../lib/team-wire.js'
import { readReviewContext } from '../../../lib/host/review-context.js'
import { reviewPresentation } from '../../../lib/host/review-presentation.js'

const stateRoot = '/root/zhijian/dsh-expert-library/work/expert-teams'
const sessionsRoot = '/root/.dsh/sessions/--root-zhijian-dsh-expert-library-work--'
const outputRoot = process.argv[2] ?? '/tmp/customer-c-historical-previews'
const sources = [
  { folder: 'chengdu', id: 'dd2c8815-287c-4bcf-8925-e9cb76ebc747', teamId: '智见报告-成都数据集团合作',
    captainSessionId: 'session-aec3fc2a-285d-4c57-b987-901ac5a3d58b', taskId: 't6', publishSeq: 44876,
    sourceFile: '20260905-cddg-coop-report-v2-designer.html',
    sourcePath: '/var/www/dsh-render/智见报告-成都数据集团合作/20260905-cddg-coop-report-v2-designer.html',
    sourceSha256: 'b25f9db892c52a78555f4016ad534714216ba2dd80c2966a40d0498106c3d408',
    sourceUrl: 'https://yy.meizu.life/render/智见报告-成都数据集团合作/20260905-cddg-coop-report-v2-designer.html' },
  { folder: 'roles', id: '8a3d657f-335c-40ad-aafc-41c6ff465f29', teamId: '智见点评-十二主体角色重写',
    captainSessionId: 'session-6d6dad49-4b0f-4e9a-afb1-ba3dba1a684e', taskId: 't7', publishSeq: 95796,
    sourceFile: 'role-rewrite-12-v54.html',
    sourcePath: '/var/www/dsh-render/智见点评-十二主体角色重写/role-rewrite-12-v54.html',
    sourceSha256: 'd145f887cfd918dfa7e021029feb109211871fd8adfeddfd2715060b148f5f86',
    sourceUrl: 'https://yy.meizu.life/render/智见点评-十二主体角色重写/role-rewrite-12-v54.html' },
  { folder: 'haixing', id: 'e1e6186d-8600-4a2f-8be5-f503b6964d57', teamId: '智见点评-海兴雅苑一居室租金定价',
    captainSessionId: 'session-397808a7-36a6-45c5-8572-606524ca54fa', taskId: 't8', publishSeq: 821,
    stateRoot: '/var/lib/dsh-server-login/users/54485b72-c5b9-4fbd-be13-bc0c2c82e0a5/ws/main/bank/expert-teams',
    sessionsRoot: '/var/lib/dsh-server-login/users/54485b72-c5b9-4fbd-be13-bc0c2c82e0a5/home/sessions/--var-lib-dsh-server-login-users-54485b72-c5b9-4fbd-be13-bc0c2c82e0a5-ws-main-bank--',
    sessionFile: 'session.v3.jsonl.zstd',
    sourceFile: 'rent-pricing.html',
    sourcePath: '/var/lib/dsh-server-login/users/54485b72-c5b9-4fbd-be13-bc0c2c82e0a5/ws/main/bank/deliverables/haixing-yayuan-1br-rent-pricing.html',
    sourceSha256: 'e01fafd4cddad9aa79abe9c7a09850d0ecb6f2016e231e431ec9f8ad128e2c73',
    sourceUrl: 'https://yy.meizu.life/render/haixing-yayuan/rent-pricing.html', reportScripts: true },
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const text = value => (value?.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('').trim()

async function sourceConversation(source) {
  const file = join(source.sessionsRoot ?? sessionsRoot, source.captainSessionId, source.sessionFile ?? 'session.jsonl.zstd')
  const child = spawn('zstdcat', ['-q', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  const rows = []
  for await (const line of createInterface({ input: child.stdout })) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.seq > source.publishSeq) continue
    let role, content
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      role = 'user'; content = text(event.data)
    } else if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model') {
      role = 'assistant'; content = text(event.data.message)
    }
    if (content) rows.push({ seq: rows.length, role, text: content, time: event.time })
  }
  const exit = await new Promise(resolve => child.on('close', resolve))
  if (exit !== 0 || !rows.length || !rows.some(row => row.text.includes(source.sourceUrl)))
    throw new Error(`source conversation unavailable: ${source.folder}`)
  return rows
}

for (const source of sources) {
  const target = { stateRoot: source.stateRoot ?? stateRoot, teamId: source.teamId, captainSessionId: source.captainSessionId, archived: true }
  const context = await readReviewContext(target)
  if (!context.team || context.team.captainSessionId !== source.captainSessionId
    || context.team.tasks.find(task => task.id === source.taskId)?.status !== 'completed') throw new Error('team mismatch')
  const report = await readFile(source.sourcePath)
  if (sha(report) !== source.sourceSha256) throw new Error(`source report changed: ${source.folder}`)
  if (source.folder === 'haixing' && sha(await readFile('/var/www/dsh-render/haixing-yayuan/rent-pricing.html')) !== source.sourceSha256)
    throw new Error('published report changed: haixing')
  const bytes = { report }
  const reportItem = { taskId: source.taskId, id: 'source-html', name: source.sourceFile,
    mediaType: 'text/html', sizeBytes: report.length, createdAt: context.team.tasks.find(task => task.id === source.taskId).updatedAt,
    formal: true, resultKey: `report:${source.taskId}`, resultLabel: context.team.name }
  const wire = { version: 1, team: teamToWire(context.team, true),
    plan: context.plan ? planToWire(context.plan) : null, archived: true }
  const presentation = reviewPresentation(context, wire, [reportItem])
  if (!wire.plan) presentation.stages.plan = 'na'
  const workspace = { ...wire, documents: [reportItem], presentation, datasets: [],
    preview: { kind: 'external-read-only', source: 'original-session', historical: true,
      captainSessionId: source.captainSessionId, teamId: source.teamId, sourceUrl: source.sourceUrl,
      reportScripts: source.reportScripts === true, capturedAt: Date.now() } }
  const messages = await sourceConversation(source)
  bytes.workspace = Buffer.from(JSON.stringify(workspace))
  bytes.messages = Buffer.from(JSON.stringify(messages))
  const manifest = { version: 1, kind: 'original-session', session: { id: source.id },
    teamId: source.teamId, captainSessionId: source.captainSessionId, sourceUrl: source.sourceUrl,
    sourceFile: source.sourceFile, workspaceSha256: sha(bytes.workspace), messagesSha256: sha(bytes.messages),
    report: { taskId: source.taskId, id: 'source-html', name: source.sourceFile,
      mediaType: 'text/html', sizeBytes: report.length, sha256: source.sourceSha256 } }
  const directory = join(outputRoot, source.folder)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const [name, content] of Object.entries({ 'manifest.json': JSON.stringify(manifest),
    'workspace.json': bytes.workspace, 'messages.json': bytes.messages, 'report.html': bytes.report }))
    await writeFile(join(directory, name), content, { mode: 0o600 })
  console.log(JSON.stringify({ folder: source.folder, teamId: source.teamId,
    tasks: wire.team.tasks.length, messages: messages.length, reportBytes: report.length }))
}
