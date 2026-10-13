import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.CUSTOMER_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')
const root = fileURLToPath(new URL('../dist/', import.meta.url))
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let aQuestionCalls = 0
let bQuestionCalls = 0
let bootstrapAttempts = 0
let sessionListAttempts = 0
let mentionCalls = 0
const firstSessionCritical = new Set()
let firstSessionAncillaryStartedEarly = false
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const json = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (path === '/api/bootstrap') {
    if (++bootstrapAttempts === 1) return req.socket.destroy()
    return json({ phase: 'S3', authenticated: true, loginProviders: [],
      user: { accountName: 'QA', displayName: '测试用户' }, researchReady: true })
  }
  if (path === '/api/sessions') {
    if (++sessionListAttempts === 1) return req.socket.destroy()
    return json({ sessions: [
    { id: a, title: '慢工作区', createdAt: Date.now() },
    { id: b, title: '新会话提问', createdAt: Date.now() },
    ] })
  }
  if (path === '/api/sessions/activity') return json({ items: [] })
  if (path === '/api/mentions') { mentionCalls++; await pause(300); return json({ items: [] }) }
  if (path.endsWith('/messages')) {
    if (path.includes(a)) firstSessionCritical.add('messages')
    return json({ messages: [], nextCursor: 0, hasMore: false, turnFailures: [] })
  }
  if (path.endsWith('/approval')) {
    if (path.includes(a)) firstSessionCritical.add('approval')
    return json({ approval: null })
  }
  if (path.endsWith('/model')) {
    if (path.includes(a) && firstSessionCritical.size < 3) firstSessionAncillaryStartedEarly = true
    return json({ selected: null })
  }
  if (path.endsWith('/question')) {
    if (path.includes(a)) {
      firstSessionCritical.add('question')
      aQuestionCalls++
      if (aQuestionCalls > 1) await pause(5000)
      return json({ question: null })
    }
    bQuestionCalls++
    if (bQuestionCalls > 1) return json({ error: 'temporary' }, 503)
    return json({ question: { requestId: '11111111-1111-4111-8111-111111111111', questions: [
      { id: 'scope', question: '请选择研究范围', options: [{ label: '全国' }], multiSelect: false },
    ] } })
  }
  if (path.endsWith('/workspace')) {
    if (path.includes(a)) {
      if (firstSessionCritical.size < 3) firstSessionAncillaryStartedEarly = true
      await pause(5000)
    }
    return json({ plan: null, team: null, documents: [], datasets: [], presentation: null })
  }
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
const browser = await chromium.launch({ executablePath: process.env.CUSTOMER_CHROMIUM || '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const started = Date.now()
  await page.goto(`http://127.0.0.1:${server.address().port}/app?session=${a}`)
  await page.locator('#conversationInput').waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('#conversationInput').disabled)
  const readyMs = Date.now() - started
  assert.ok(readyMs < 3000, `conversation waited ${readyMs} ms for a five-second workspace request`)
  assert.equal(firstSessionAncillaryStartedEarly, false, 'model or workspace contended with initial conversation recovery')
  assert.equal(bootstrapAttempts, 2)
  assert.equal(sessionListAttempts, 2)
  await page.waitForFunction(() => document.querySelector('#conversationMessages .conversationEmpty'))
  const deadline = Date.now() + 6500
  while (aQuestionCalls < 2 && Date.now() < deadline) await pause(100)
  assert.ok(aQuestionCalls >= 2, 'old session poll did not start')
  await page.locator('.sessionItem').filter({ hasText: '新会话提问' }).click()
  await page.locator('#questionCard').waitFor({ state: 'visible', timeout: 2500 })
  assert.equal(await page.locator('#questionCard legend').innerText(), '请选择研究范围')
  await pause(7500)
  assert.ok(bQuestionCalls <= 3, `failed question endpoint was polled ${bQuestionCalls} times`)
  assert.equal(mentionCalls, 0, 'mentions were fetched before the user typed @')
  await page.locator('.sessionItem').filter({ hasText: '慢工作区' }).click()
  await page.waitForFunction(() => !document.querySelector('#conversationInput').disabled)
  await page.locator('#conversationInput').fill('@')
  await page.locator('.mentionEmpty').filter({ hasText: '正在读取可用对象' }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.mentionMenuHeading')?.textContent === '选择对象类型')
  assert.equal(mentionCalls, 1)
  await page.evaluate(() => {
    window.__qaRealNow = Date.now.bind(Date)
    Date.now = () => window.__qaRealNow() + 30_000
  })
  await page.locator('#conversationInput').fill('@a')
  await pause(100)
  assert.equal(mentionCalls, 1, 'typing @ again should reuse the recent catalog')
  await page.evaluate(() => { Date.now = () => window.__qaRealNow() + 6 * 60_000 })
  await page.locator('#conversationInput').fill('@ab')
  await page.waitForFunction(() => document.querySelector('.mentionMenuHeading')?.textContent === '选择对象类型')
  const mentionDeadline = Date.now() + 1500
  while (mentionCalls < 2 && Date.now() < mentionDeadline) await pause(25)
  assert.equal(mentionCalls, 2, 'stale catalog should refresh in the background')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ readyMs, bootstrapAttempts, sessionListAttempts, mentionCalls,
    oldQuestionCalls: aQuestionCalls, newQuestionCalls: bQuestionCalls, errors }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
