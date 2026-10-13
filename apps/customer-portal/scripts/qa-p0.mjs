import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.CUSTOMER_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')

const root = fileURLToPath(new URL('../dist/', import.meta.url))
const evidenceDir = process.env.CUSTOMER_P0_EVIDENCE || '/tmp'
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const c = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
let question = { requestId: '11111111-1111-4111-8111-111111111111', questions: [
  { id: 'scope', question: '研究哪个范围？', options: [{ label: '一线城市' }, { label: '全国' }], multiSelect: false },
] }
const team = { id: 'team-b', name: '上海租赁市场研判', members: [
  { id: 'm1', name: '市场研究员', role: '研究', expertId: 'researcher' },
  { id: 'm2', name: '报告审核员', role: '报告', expertId: 'reviewer' },
],
  tasks: [
    { id: 't1', subject: '证据研究', assignee: '市场研究员', status: 'completed', dependencies: [], description: '核对市场数据。 Approved artifact flow: {"x":1}' },
    { id: 't2', subject: '正式报告', assignee: '报告审核员', status: 'completed', dependencies: ['t1'], description: '撰写最终报告。' },
  ], qualityRuns: [] }
const documents = [
  { id: 'pdf', taskId: 't2', name: 'report.pdf', formal: true, resultKey: 'final', resultLabel: '上海租赁市场研判', createdAt: 1791500000000 },
  { id: 'md', taskId: 't2', name: 'report.md', formal: true, resultKey: 'final', createdAt: 1791500000000 },
  { id: 'old', taskId: 't2', name: 'report.pdf', draft: true, createdAt: 1791400000000 },
  { id: 'evidence', taskId: 't1', name: 'evidence.md', resultKind: 'evidence', createdAt: 1791400000000 },
]
const workspaceA = { plan: { revision: 2, status: 'completed', runtime: { teamName: '上海租赁市场研判' },
  preview: { tasks: [{ id: 't1', dependsOn: [] }, { id: 't2', dependsOn: ['t1'] }] } },
  team, documents, presentation: { mode: 'research', labels: { plan: '研究计划', outline: '研究大纲', activity: '团队进展', results: '研究成果' },
    stages: { plan: 'done', outline: 'done', activity: 'done', results: 'done' }, experts: {
      m1: { label: '市场研究员', portrait: 'asset:pose-market-survey' },
      m2: { label: '报告审核员', portrait: 'asset:pose-reviewer-check' },
    } }, datasets: [] }
const workspaceC = { ...workspaceA, team: { ...team, id: 'team-working', tasks: [
  { ...team.tasks[0], status: 'completed' }, { ...team.tasks[1], status: 'in_progress' },
] }, documents: [], presentation: { ...workspaceA.presentation, stages: { plan: 'done', outline: 'done', activity: 'pending', results: 'pending' } } }
const workspaceB = { plan: { revision: 1, status: 'staged', digest: 'a'.repeat(64), runtime: { teamName: '新研究' },
  preview: { tasks: [], reportOutline: { chapters: [] } } }, team: null, documents: [],
  presentation: { mode: 'research', labels: { plan: '研究计划', outline: '研究大纲', activity: '团队进展', results: '研究成果' },
    stages: { plan: 'pending', outline: 'pending', activity: 'pending', results: 'pending' }, experts: {} },
  datasets: [], delivery: { ready: true }, contextReview: { planId: 'plan-1', digest: 'a'.repeat(64), revision: 1,
    currentSha256: 'b'.repeat(64), changed: true, newMessages: [{ id: 'new-1', seq: 2, text: '请增加广州作为对照城市。' }] } }

const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', webp: 'image/webp' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  if (url.pathname === '/api/bootstrap') return send({ phase: 'S3', authenticated: true, loginProviders: [], user: { accountName: 'B', displayName: '测试用户' }, researchReady: true })
  if (url.pathname === '/api/sessions') return send({ sessions: [
    { id: a, title: '已交付会话', createdAt: Date.now() }, { id: b, title: '待办会话', createdAt: Date.now() },
    { id: c, title: '执行中会话', createdAt: Date.now() },
  ] })
  if (url.pathname === '/api/mentions') return send({ items: [] })
  if (url.pathname.endsWith('/messages')) return send({ messages: [], nextCursor: 0, hasMore: false, turnFailures: [] })
  if (url.pathname.endsWith('/question')) {
    if (req.method === 'POST') { question = null; return send({ accepted: true }) }
    return send({ question: url.pathname.includes(b) ? question : null })
  }
  if (url.pathname.endsWith('/workspace')) return send(url.pathname.includes(a) ? workspaceA : url.pathname.includes(c) ? workspaceC : workspaceB)
  if (url.pathname.endsWith('/workspace/action') && req.method === 'POST') {
    workspaceB.plan.revision = 2
    workspaceB.contextReview.changed = false
    workspaceB.contextReview.revision = 2
    workspaceB.contextReview.newMessages = []
    return send(workspaceB)
  }
  if (url.pathname.includes('/workspace/documents/')) return send({ document: { name: 'report.pdf', content: 'JVBERi0xLjQK', encoding: 'base64', mediaType: 'application/pdf' } })
  let path = url.pathname === '/app' ? '/index.html' : url.pathname
  if (path === '/assets/app.js' || path === '/assets/style.css') path = path.replace('/assets', '')
  try { const body = await readFile(root + path); res.writeHead(200, { 'content-type': mime[path.split('.').at(-1)] || 'application/octet-stream' }); res.end(body) }
  catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CUSTOMER_CHROMIUM || '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell', headless: true, args: ['--no-sandbox'] })
const results = []
try {
  for (const width of [320, 390, 1280, 1440]) {
    workspaceB.plan.revision = 1
    workspaceB.contextReview.changed = true
    workspaceB.contextReview.revision = 1
    workspaceB.contextReview.newMessages = [{ id: 'new-1', seq: 2, text: '请增加广州作为对照城市。' }]
    question = { requestId: '11111111-1111-4111-8111-111111111111', questions: [
      { id: 'scope', question: '研究哪个范围？', options: [{ label: '一线城市' }, { label: '全国' }], multiSelect: false },
    ] }
    const page = await browser.newPage({ viewport: { width, height: 850 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/app`)
    if (width < 900) await page.locator('#menuButton').click()
    await page.locator('.sessionItem').filter({ hasText: '已交付会话' }).click()
    await page.locator('[data-tab="workspace"]').click()
    await page.locator('.workspaceFormalReport').waitFor({ state: 'attached' })
    const delivered = {
      phase: await page.locator('#workspacePhase').innerText(),
      reportCards: await page.locator('.workspaceFormalReport').count(),
      archive: await page.locator('.workspaceArchive').innerText(),
      overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    }
    await page.locator('#workspacePrimary').click()
    delivered.previewOpened = await page.locator('#workspaceDocumentDialog').isVisible()
    await page.locator('#workspaceDocumentBody iframe[src^="blob:"]').waitFor({ state: 'attached' })
    delivered.previewTitle = await page.locator('#workspaceDocumentTitle').innerText()
    delivered.downloadReady = await page.locator('#workspaceDocumentDownload').evaluate(node => !node.hidden && node.href.startsWith('blob:'))
    await page.locator('#workspaceDocumentClose').click()
    await page.locator('[data-workspace-tab="results"]').click()
    delivered.sceneHidden = await page.locator('.workspaceOverview .heroScene').isHidden()
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
    await page.screenshot({ path: `${evidenceDir}/customer-p0-report-${width}.png`, fullPage: true })
    await page.locator('[data-workspace-tab="team"]').click()
    const routeVisible = await page.locator('.workspaceRoute').isVisible()
    if (width < 900) await page.getByRole('button', { name: '人物路线' }).click()
    await page.locator('.workspaceRouteCanvas svg path').first().waitFor({ state: 'attached' })
    delivered.routePaths = await page.locator('.workspaceRouteCanvas svg path').count()
    delivered.routeHeading = await page.locator('.workspaceRouteHead h3').innerText()
    delivered.fitSelectedOnOpen = await page.getByRole('button', { name: '全图' }).getAttribute('aria-pressed')
    delivered.initialFrameWidth = await page.locator('.workspaceRouteFrame').evaluate(node => node.getBoundingClientRect().width)
    delivered.initialViewportWidth = await page.locator('.workspaceRouteViewport').evaluate(node => node.clientWidth)
    if (width === 390) await page.locator('.workspaceRoute').screenshot({ path: `${evidenceDir}/customer-p0-route-initial-${width}.png` })
    delivered.actorCount = await page.locator('.workspaceRouteScene .workspaceRoutePerson').count()
    delivered.nodeWidth = await page.locator('.workspaceRouteNode').first().evaluate(node => Math.round(node.getBoundingClientRect().width))
    delivered.teamProgressCount = await page.locator('.workspaceTeamProgress').count()
    delivered.firstNodeFromTeamTop = await page.evaluate(() => Math.round(
      document.querySelector('.workspaceRouteNode').getBoundingClientRect().bottom
      - document.querySelector('#workspaceTeamPanel').getBoundingClientRect().top))
    await page.locator('.workspaceRouteNode').first().click()
    delivered.selectedPath = await page.locator('.workspaceRouteCanvas svg path[data-active="true"]').count()
    await page.getByRole('button', { name: '缩小研究路线' }).click()
    delivered.zoomedWidth = await page.locator('.workspaceRouteFrame').evaluate(node => Math.round(node.getBoundingClientRect().width))
    await page.getByRole('button', { name: '原大小' }).click()
    delivered.actualWidth = await page.locator('.workspaceRouteFrame').evaluate(node => Math.round(node.getBoundingClientRect().width))
    await page.getByRole('button', { name: '回到起点' }).click()
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
    await page.screenshot({ path: `${evidenceDir}/customer-p0-${width}.png`, fullPage: true })
    if (width === 390 || width === 1280) {
      await page.locator('.topbar').evaluate(node => { node.style.visibility = 'hidden' })
      await page.locator('.workspaceRoute').screenshot({ path: `${evidenceDir}/customer-p0-route-${width}.png` })
      await page.locator('.topbar').evaluate(node => { node.style.visibility = '' })
    }
    if (width < 900) await page.locator('#menuButton').click()
    await page.locator('.sessionItem').filter({ hasText: '执行中会话' }).click()
    await page.locator('[data-tab="workspace"]').click()
    await page.locator('[data-workspace-tab="team"]').click()
    await page.locator('.workspaceExpert[data-status="working"]').waitFor({ state: 'attached' })
    const working = { animation: await page.locator('.workspaceExpert[data-status="working"] img').evaluate(node => getComputedStyle(node).animationName),
      listDefault: await page.locator('.workspaceTaskList').evaluate(node => !node.hidden),
      sceneHidden: await page.locator('.workspaceOverview .heroScene').isHidden() }
    await page.locator('[data-workspace-tab="team"]').click()
    if (width >= 900) {
      working.routeAnimation = await page.locator('.workspaceRouteNode[data-tone="working"] .workspaceRoutePerson')
        .evaluate(node => getComputedStyle(node).animationName)
      working.paperHandoff = await page.locator('.workspaceRouteCourier').count()
    }
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }))
    await page.screenshot({ path: `${evidenceDir}/customer-p0-working-${width}.png`, fullPage: true })
    if (width < 900) await page.locator('#menuButton').click()
    await page.locator('.sessionItem').filter({ hasText: '待办会话' }).click()
    await page.locator('#questionCard').waitFor({ state: 'visible' })
    const pending = { count: await page.locator('#actionCount').innerText(), actionVisible: await page.locator('#actionCenter').isVisible() }
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${evidenceDir}/customer-p0-pending-${width}.png`, fullPage: true })
    await page.locator('#questionCard input[type="radio"]').first().check()
    await page.locator('#questionCard button[type="submit"]').click()
    await page.waitForTimeout(120)
    pending.afterAnswer = await page.locator('#actionCount').innerText()
    await page.locator('#actionItems button').first().click()
    pending.planVisible = await page.locator('#workspacePlanPanel').isVisible()
    pending.contextReview = await page.locator('.workspaceContextReview').isVisible()
    pending.approveDisabled = await page.getByRole('button', { name: '确认并启动团队' }).isDisabled()
    await page.screenshot({ path: `${evidenceDir}/customer-p0-context-${width}.png`, fullPage: true })
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '原计划仍适用，生成新版' }).click()
    await page.waitForFunction(() => document.querySelector('#workspacePlan')?.textContent?.includes('第 2 版'))
    pending.newRevision = await page.locator('#workspacePlan').innerText()
    assert.equal(delivered.phase, '报告已交付')
    assert.equal(delivered.reportCards, 1)
    assert.equal(delivered.archive.includes('report.pdf'), false)
    assert.equal(delivered.overflow, false)
    assert.equal(delivered.previewOpened, true)
    assert.equal(delivered.previewTitle, 'report.pdf')
    assert.equal(delivered.downloadReady, true)
    assert.equal(delivered.sceneHidden, true)
    assert.equal(delivered.routePaths, 1)
    assert.equal(delivered.routeHeading, '研究路线')
    if (width < 621) {
      assert.equal(delivered.fitSelectedOnOpen, 'true')
      assert.ok(Math.abs(delivered.initialFrameWidth - (delivered.initialViewportWidth - 4)) < 3)
    } else assert.equal(delivered.fitSelectedOnOpen, 'false')
    assert.equal(delivered.actorCount, 2)
    assert.equal(delivered.teamProgressCount, 0)
    if (width <= 390) assert.ok(delivered.firstNodeFromTeamTop < 850)
    assert.ok(delivered.nodeWidth > 0 && delivered.nodeWidth <= 244)
    if (width >= 900) assert.equal(delivered.nodeWidth, 244)
    assert.equal(delivered.selectedPath, 1)
    assert.ok(delivered.zoomedWidth < delivered.actualWidth)
    assert.equal(delivered.actualWidth, 616)
    assert.equal(working.animation, 'workspaceExpertWork')
    assert.equal(working.sceneHidden, true)
    assert.equal(working.listDefault, false)
    if (width >= 900) { assert.equal(working.routeAnimation, 'workspaceRouteResearch'); assert.equal(working.paperHandoff, 1) }
    assert.equal(pending.count, '2')
    assert.equal(pending.actionVisible, true)
    assert.equal(pending.afterAnswer, '1')
    assert.equal(pending.planVisible, true)
    assert.equal(pending.contextReview, true)
    assert.equal(pending.approveDisabled, true)
    assert.match(pending.newRevision, /第 2 版/)
    assert.deepEqual(errors, [])
    results.push({ width, delivered, routeVisible, working, pending, errors })
    await page.close()
  }
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
