import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.CUSTOMER_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')
const root = fileURLToPath(new URL('../dist/', import.meta.url))
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sessions = [
  { id: sessionId, title: '江苏银行零售研究', createdAt: Date.now(), pinned: false, favorite: false, archived: false, groupId: null },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '市场观察', createdAt: Date.now() - 86400000, pinned: false, favorite: false, archived: false, groupId: null },
]
const groups = []
async function bodyJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (path === '/api/bootstrap') return json({ phase: 'S3', authenticated: true, loginProviders: [], user: { accountName: 'sidebar-qa', displayName: '测试用户' }, researchReady: true })
  if (path === '/api/sessions' && req.method === 'GET') return json({ sessions, groups })
  if (path === '/api/session-groups' && req.method === 'POST') {
    const body = await bodyJson(req)
    const group = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: body.name }
    groups.push(group)
    return json({ group }, 201)
  }
  if (path === `/api/sessions/${sessionId}` && req.method === 'PATCH') {
    Object.assign(sessions[0], await bodyJson(req))
    return json({ session: sessions[0] })
  }
  if (path === '/api/sessions/activity') return json({ items: [], hasUnknown: false })
  if (path.endsWith('/messages')) return json({ messages: [], nextCursor: 0, hasMore: false })
  if (path.endsWith('/question')) return json({ question: null })
  if (path.endsWith('/workspace')) return json({ plan: null, team: null, documents: [], datasets: [] })
  if (path === '/api/mentions') return json({ items: [] })
  let file = path === '/app' ? '/index.html' : path
  if (file === '/assets/app.js' || file === '/assets/style.css') file = file.replace('/assets', '')
  try {
    const data = await readFile(root + file)
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CUSTOMER_CHROMIUM || '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell', headless: true, args: ['--no-sandbox'] })
try {
  for (const width of [320, 390, 1280]) {
    groups.length = 0
    sessions[0].groupId = null
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/app`)
    if (width < 900) await page.locator('#menuButton').click()
    await page.locator('.sessionItem').first().waitFor()
    await page.locator('#sessionDensity').click()
    assert.equal(await page.locator('.sessionSidebar').evaluate(node => node.classList.contains('dense')), true)
    const rowHeight = await page.locator('.sessionRow').first().evaluate(node => node.getBoundingClientRect().height)
    assert.ok(rowHeight <= 48, `compact row too tall: ${rowHeight}`)
    await page.locator('#sessionSearch').fill('江苏银行')
    assert.equal(await page.locator('.sessionItem').count(), 1)
    await page.locator('#sessionSearch').fill('')
    await page.locator('#newSessionGroup').click()
    await page.locator('#sessionGroupInput').fill('金融研究')
    await page.locator('#sessionGroupForm [type="submit"]').click()
    await page.locator('#sessionGroupMode').selectOption('custom')
    await page.locator('.sessionRowMenu summary').first().click()
    await page.locator('.sessionRowMenu select').first().selectOption(groups[0].id)
    await page.getByRole('button', { name: /金融研究/ }).first().waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: `/tmp/customer-sidebar-${width}.png` })
    await page.close()
  }
  process.stdout.write('sidebar desktop/mobile QA passed\n')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
