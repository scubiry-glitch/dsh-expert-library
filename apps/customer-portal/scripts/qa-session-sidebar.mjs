import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.CUSTOMER_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')
const root = fileURLToPath(new URL('../dist/', import.meta.url))
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sessions = [
  { id: sessionId, title: '江苏银行零售研究', createdAt: Date.now(), pinned: false, favorite: false, archived: false, groupId: null, spaceId: null, presetId: 'zhijian' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '市场观察', createdAt: Date.now() - 86400000, pinned: false, favorite: false, archived: false, groupId: null },
]
const groups = []
const spaces = []
const webSearchPolicies = new Map()
async function bodyJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (path === '/api/bootstrap') return json({ phase: 'S3', authenticated: true, loginProviders: [], user: { accountName: 'sidebar-qa', displayName: '测试用户' }, researchReady: true })
  if (path === '/api/sessions' && req.method === 'GET') return json({ sessions, groups, spaces })
  if (path === '/api/presets' && req.method === 'GET') return json({ defaultId: 'zhijian', presets: [
    { id: 'zhijian', name: '智见预设' }, { id: 'standard', name: '标准预设' }] })
  if (path === '/api/spaces' && req.method === 'POST') {
    const body = await bodyJson(req)
    const parent = spaces.find(item => item.id === body.parentId)
    const space = { id: `space-${spaces.length + 1}`, parentId: body.parentId ?? null,
      name: body.name, relativePath: `${parent?.relativePath ?? 'spaces'}/${body.name}` }
    spaces.push(space)
    return json({ space }, 201)
  }
  if (path === '/api/sessions' && req.method === 'POST') {
    const body = await bodyJson(req)
    const session = { id: crypto.randomUUID(), title: '新研究会话', createdAt: Date.now(),
      pinned: false, favorite: false, archived: false, groupId: null, spaceId: body.spaceId,
      presetId: body.presetId }
    sessions.unshift(session)
    return json({ session }, 201)
  }
  if (/^\/api\/sessions\/[^/]+\/preset$/.test(path)) {
    const session = sessions.find(item => path.includes(item.id))
    if (req.method === 'GET') return json({ presetId: session?.presetId ?? 'zhijian', canSwitch: true })
    if (req.method === 'POST') {
      session.presetId = (await bodyJson(req)).presetId
      return json({ presetId: session.presetId, canSwitch: true })
    }
  }
  if (/^\/api\/sessions\/[^/]+\/web-search$/.test(path)) {
    const id = path.split('/')[3]
    if (req.method === 'GET') return json({ policy: webSearchPolicies.get(id) ?? 'ask' })
    if (req.method === 'PUT') {
      const { policy } = await bodyJson(req)
      webSearchPolicies.set(id, policy)
      return json({ policy })
    }
  }
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
    assert.equal(await page.locator('#conversationSettings').evaluate(node => node.open), false)
    assert.equal(await page.locator('#conversationSearchPolicy').isVisible(), false)
    const sidebarList = await page.locator('.sessionList').boundingBox()
    assert.ok(sidebarList.y < 180, `sidebar controls too tall at ${width}px: ${sidebarList.y}`)
    await page.locator('#archivedSessionsButton').click()
    assert.equal(await page.locator('#archivedSessionsButton').getAttribute('aria-pressed'), 'true')
    await page.locator('#allSessionsButton').click()
    if (width === 1280) {
      await page.locator('#conversationSettings summary').click()
      await page.locator('#conversationSearchPolicy').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#conversationSearchPolicy').inputValue(), 'ask')
    }
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
    if (width === 1280) {
      await page.locator('#newSpaceButton').click()
      await page.locator('#newSpaceName').fill('项目甲')
      await page.locator('#newSpaceForm [type="submit"]').click()
      await page.getByRole('button', { name: /项目甲/ }).first().waitFor()
      await page.locator('#newSpaceButton').click()
      await page.locator('#newSpaceParent').selectOption(spaces[0].id)
      await page.locator('#newSpaceName').fill('阶段一')
      await page.locator('#newSpaceForm [type="submit"]').click()
      await page.getByRole('button', { name: /项目甲\/阶段一/ }).first().waitFor()
      assert.equal(spaces[1].relativePath, 'spaces/项目甲/阶段一')
      await page.locator('#newSessionButton').click()
      await page.locator('#newSessionSpace').selectOption(spaces[1].id)
      await page.locator('#newSessionPreset').selectOption('standard')
      await page.locator('#newSessionForm [type="submit"]').click()
      await page.locator('#newSessionDialog').waitFor({ state: 'hidden' })
      assert.equal(sessions[0].spaceId, spaces[1].id)
      assert.equal(sessions[0].presetId, 'standard')
      const switched = page.waitForResponse(response => response.url().includes(`/api/sessions/${sessions[0].id}/preset`)
        && response.request().method() === 'POST')
      await page.locator('#conversationPresetSelect').selectOption('zhijian')
      await switched
      assert.equal(sessions[0].presetId, 'zhijian')
      const savedPolicy = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${sessions[0].id}/web-search`)
        && response.request().method() === 'PUT')
      await page.locator('#conversationSearchPolicy').selectOption('off')
      await savedPolicy
      assert.equal(webSearchPolicies.get(sessions[0].id), 'off')
    }
    if (width < 900) {
      await page.screenshot({ path: `/tmp/customer-sidebar-open-${width}.png` })
      await page.locator('#closeSidebar').click()
      await page.waitForTimeout(350)
      await page.screenshot({ path: `/tmp/customer-settings-collapsed-${width}.png` })
      await page.locator('#conversationSettings summary').click()
      const action = await page.locator('.conversationActionRow').boundingBox()
      const selectors = ['#conversationWorkspaceTrigger', '.conversationPresetPicker', '#conversationModelTrigger', '.conversationSearchPicker']
      const fields = await Promise.all(selectors.map(selector => page.locator(selector).boundingBox()))
      assert.ok(fields.every(field => field.y >= action.y + action.height))
      assert.ok(fields.every(field => Math.abs(field.y - fields[0].y) < 6))
      assert.ok(fields.every(field => field.x >= 0 && field.x + field.width <= width))
      await page.locator('#conversationSearchPolicy').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#conversationSearchPolicy').inputValue(), 'ask')
      await page.screenshot({ path: `/tmp/customer-settings-expanded-${width}.png` })
      await page.locator('#conversationWorkspaceTrigger').click()
      await page.locator('#newSessionDialog').waitFor({ state: 'visible' })
      await page.locator('#newSessionCancel').click()
      await page.locator('#conversationSettings summary').click()
      assert.equal(await page.locator('#conversationSearchPolicy').isVisible(), false)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: `/tmp/customer-sidebar-${width}.png` })
    await page.close()
  }
  process.stdout.write('sidebar desktop/mobile QA passed\n')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
