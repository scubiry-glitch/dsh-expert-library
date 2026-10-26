import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.CUSTOMER_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')
const root = fileURLToPath(new URL('../dist/', import.meta.url))
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let uploaded
let sent
let removed
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (path === '/api/bootstrap') return json({ authenticated: true, researchReady: true, phase: 'S3', loginProviders: [], user: { accountName: 'QA', displayName: '测试用户' } })
  if (path === '/api/sessions') return json({ sessions: [{ id: session, title: '附件验证', createdAt: Date.now() }] })
  if (path === '/api/sessions/activity') return json({ items: [] })
  if (path.endsWith('/attachments') && req.method === 'POST') {
    uploaded = await readBody(req)
    return json({ name: uploaded.name, path: `customer-uploads/session-${session}/00000000-0000-4000-8000-000000000000-${uploaded.name}`, sizeBytes: 5 }, 201)
  }
  if (path.endsWith('/attachments') && req.method === 'DELETE') { removed = await readBody(req); return json({ removed: true }) }
  if (path.endsWith('/messages')) {
    if (req.method === 'POST') { sent = await readBody(req); return json({ accepted: true }, 202) }
    return json({ messages: [], nextCursor: -1, hasMore: false })
  }
  if (path.endsWith('/question')) return json({ question: null })
  if (path.endsWith('/approval')) return json({ approval: null })
  if (path.endsWith('/model')) return json({ selected: null, models: [] })
  if (path.endsWith('/workspace')) return json({ plan: null, team: null, documents: [], datasets: [] })
  let file = path === '/app' ? '/index.html' : path
  if (file.startsWith('/assets/app.js') || file.startsWith('/assets/style.css')) file = file.replace('/assets', '')
  try {
    const data = await readFile(root + file)
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CUSTOMER_CHROMIUM || '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: process.env.CUSTOMER_ATTACHMENT_MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/app?session=${session}`)
  await page.locator('#attachmentButton').waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('#attachmentButton').disabled)
  await page.locator('#attachmentInput').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await page.locator('.conversationAttachment[data-state="ready"]').waitFor()
  await page.locator('.conversationAttachment button').click()
  await page.waitForFunction(() => !document.querySelector('.conversationAttachment'))
  assert.match(removed.path, /^customer-uploads\/session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\//)
  await page.locator('#attachmentInput').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await page.locator('.conversationAttachment[data-state="ready"]').waitFor()
  if (process.env.CUSTOMER_ATTACHMENT_SCREENSHOT) await page.screenshot({ path: process.env.CUSTOMER_ATTACHMENT_SCREENSHOT })
  assert.equal(uploaded.data, 'aGVsbG8=')
  await page.locator('#conversationInput').fill('请总结附件')
  await page.locator('#sendMessageButton').click()
  await page.waitForFunction(() => !document.querySelector('.conversationAttachment'))
  assert.match(sent.text, /请总结附件[\s\S]*notes\.txt：customer-uploads\/session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\//)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ uploaded: uploaded.name, removed: true, sent: true, errors }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
