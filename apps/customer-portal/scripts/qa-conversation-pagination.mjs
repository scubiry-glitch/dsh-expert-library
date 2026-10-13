import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.CUSTOMER_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')
const root = fileURLToPath(new URL('../dist/', import.meta.url))
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const messages = Array.from({ length: 80 }, (_, seq) => ({ id: `m-${seq}`, seq,
  role: seq % 2 ? 'assistant' : 'user', text: `消息 ${seq}`, time: Date.now() }))
const requests = []
let account = 'QA'
let slowRevalidation = false
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (path === '/api/bootstrap') return json({ phase: 'S3', authenticated: true, loginProviders: [],
    user: { accountName: account, displayName: '测试用户' }, researchReady: true })
  if (path === '/api/sessions') {
    if (slowRevalidation) await new Promise(resolve => setTimeout(resolve, 1500))
    return json({ sessions: account === 'QA' ? [
    { id: session, title: '长会话', createdAt: Date.now() },
    { id: other, title: '其他会话', createdAt: Date.now() },
    ] : [{ id: other, title: '其他会话', createdAt: Date.now() }] })
  }
  if (path === '/api/sessions/activity') return json({ items: [] })
  if (path.endsWith('/messages')) {
    requests.push(url.search)
    if (path.includes(other)) return json({ messages: [], nextCursor: -1, hasMore: false })
    const after = Number(url.searchParams.get('after') ?? -1)
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)
    if (url.searchParams.get('latest') === '1') {
      if (slowRevalidation) await new Promise(resolve => setTimeout(resolve, 1500))
      if (before === Number.MAX_SAFE_INTEGER) await new Promise(resolve => setTimeout(resolve, 350))
      const eligible = messages.filter(item => item.seq < before)
      const page = eligible.slice(-30)
      return json({ messages: page, nextCursor: before === Number.MAX_SAFE_INTEGER ? messages.at(-1)?.seq ?? -1 : -1,
        hasMore: false, hasEarlier: eligible.length > page.length })
    }
    const page = messages.filter(item => item.seq > after).slice(0, 30)
    return json({ messages: page, nextCursor: page.at(-1)?.seq ?? after, hasMore: false })
  }
  if (path.endsWith('/question')) return json({ question: null })
  if (path.endsWith('/approval')) return json({ approval: null })
  if (path.endsWith('/workspace')) return json({ plan: null, team: null, documents: [], datasets: [], presentation: null })
  if (path.endsWith('/model')) return json({ selected: null, models: [] })
  let file = path === '/app' ? '/index.html' : path
  if (file.startsWith('/assets/app.js') || file.startsWith('/assets/style.css')) file = file.replace('/assets', '')
  try {
    const data = await readFile(root + file)
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript'
      : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CUSTOMER_CHROMIUM || '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell',
  headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/app?session=${session}`)
  await page.locator('.conversationEmpty.isLoading').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelectorAll('.conversationMessage[data-seq]').length === 30)
  assert.equal(await page.locator('.conversationMessage[data-seq]').first().getAttribute('data-seq'), '50')
  assert.equal(await page.locator('#conversationInput').isDisabled(), false)
  assert.equal(requests.filter(query => query.includes('latest=1')).length, 1)
  await page.locator('.conversationEarlier').click()
  await page.waitForFunction(() => document.querySelectorAll('.conversationMessage[data-seq]').length === 60)
  assert.equal(await page.locator('.conversationMessage[data-seq]').first().getAttribute('data-seq'), '20')
  await page.locator('.conversationEarlier').click()
  await page.waitForFunction(() => document.querySelectorAll('.conversationMessage[data-seq]').length === 80)
  assert.equal(await page.locator('.conversationMessage[data-seq]').first().getAttribute('data-seq'), '0')
  assert.equal(await page.locator('.conversationEarlier').count(), 0)
  await page.locator('#menuButton').click()
  await page.locator('.sessionItem').filter({ hasText: '其他会话' }).click()
  await page.waitForFunction(() => document.querySelector('#conversationMessages .conversationEmpty'))
  assert.equal(await page.locator('.conversationMessage[data-seq]').count(), 0)
  await page.locator('#menuButton').click()
  await page.locator('.sessionItem').filter({ hasText: '长会话' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.conversationMessage[data-seq]').length === 30)
  await page.waitForTimeout(200)
  messages.at(-1).text = '服务器更新的回复'
  slowRevalidation = true
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.conversationMessage[data-seq]').length === 30, undefined, { timeout: 1000 })
  assert.equal(await page.locator('.sessionItem').filter({ hasText: '长会话' }).count(), 1)
  await page.locator('.conversationMessage').filter({ hasText: '服务器更新的回复' }).waitFor({ timeout: 5000 })
  assert.equal(await page.locator('.conversationMessage[data-seq]').count(), 30, 'server should replace cached messages')
  assert.equal(await page.locator('.conversationMessage').filter({ hasText: '服务器更新的回复' }).count(), 1)
  account = 'QB'
  await page.reload()
  await page.waitForTimeout(500)
  assert.equal(await page.locator('.sessionItem').filter({ hasText: '长会话' }).count(), 0, 'another account must not see cached sessions')
  assert.equal(await page.locator('.conversationMessage[data-seq]').count(), 0, 'another account must not see cached messages')
  await page.waitForFunction(() => document.querySelector('.sessionItem[data-session-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]'), undefined, { timeout: 4000 })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ initialMessages: 30, totalMessages: 80, historyPages: 2,
    cachedFirstPaint: true, accountIsolated: true, pageErrors: errors }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
