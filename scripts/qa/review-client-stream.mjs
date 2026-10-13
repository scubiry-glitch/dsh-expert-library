// Isolated loopback Host fixture: never contacts production or invokes a model.
// Override REVIEW_PLAYWRIGHT_MODULE / REVIEW_CHROMIUM for other environments.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { handleReviewRoutes, REVIEW_PREFIX } from '../../src/host/review-routes.ts'
import { issueReviewAccess, exchangeReviewAccess } from '../../src/host/review-access.ts'
import { projectConversation } from '../../src/host/review-conversation.ts'
import { createReviewEventHub } from '../../src/host/review-event-hub.ts'
import { createReviewStateWatch } from '../../src/host/review-state-watch.ts'
const { chromium } = await import(process.env.REVIEW_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')
const root = await mkdtemp(join(tmpdir(), 'review-client-browser-'))
const hooks = new Map(), disposers = []
const hub = createReviewEventHub({ on(name, fn) { hooks.set(name, fn) }, effect(fn) { disposers.push(fn()) } })
const watch = createReviewStateWatch(50)
const events = [], requests = { state: 0, conversation: 0, events: 0, writes: 0 }
let activeStreams = 0, failedSend = false, sends = []
const seen = new Set()
function append(role, text, rpcId) {
  const seq = events.length
  const content = [{ type: 'text', text }]
  const event = { seq, time: Date.now(), type: `${role}/message`, surfaceOp: 'append', data: role === 'user'
    ? { id: `m${seq}`, source: { kind: 'user', rpcId }, content }
    : { message: { id: `m${seq}`, content } } }
  events.push(event); hooks.get('session/event')({ id: 'captain' }, event)
  return seq
}
for (let i = 0; i < 5; i++) append(i % 2 ? 'assistant' : 'user', `初始消息 ${i}`)
const state = { version: 1, captainSessionId: 'captain', archived: false, plan: null,
  team: { id: 'team', captainSessionId: 'captain', name: '隔离通信测试', members: [], tasks: [] } }
const runtime = {
  stateRoots: () => [root], resolve: async captain => captain === 'captain' ? { stateRoot: root, captainSessionId: captain, teamId: 'team', archived: false } : undefined,
  read: async () => { requests.state++; return state }, action: async () => { throw Error('fixture forbids actions') },
  conversation: async (_id, after, latest, before) => { requests.conversation++; return projectConversation(events, after, latest, before) },
  subscribeSession(id, fn) { activeStreams++; const leave = hub(id, fn); return () => { activeStreams--; leave() } },
  subscribeState: watch.subscribe,
  sendMessage: async (_id, text, requestId) => {
    requests.writes++; sends.push(requestId)
    if (!seen.has(requestId)) { seen.add(requestId); append('user', text, requestId) }
    if (!failedSend) { failedSend = true; throw Error('lost receipt') }
    return { accepted: true }
  },
}
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname.endsWith('/api/events')) requests.events++
  handleReviewRoutes(req, res, url, runtime).then(handled => { if (!handled) { res.statusCode = 404; res.end() } }).catch(error => { console.error(error); res.end() })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.REVIEW_CHROMIUM || '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell', headless: true, args: ['--no-sandbox'] })
const errors = []
try {
  await mkdir(join(root, 'team')); await writeFile(join(root, 'team/team.json'), '{}')
  const issued = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team' })
  const access = await exchangeReviewAccess([root], issued.token)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await context.addCookies([{ name: `expert_review_session_${access.record.id}`, value: access.cookie, domain: '127.0.0.1', path: REVIEW_PREFIX, httpOnly: true, sameSite: 'Strict' }])
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
  // The latest button now scrolls locally. Expose a read helper only inside
  // this intercepted test asset to retain the HTTP/SSE race regression.
  await page.route('**/review.js?*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace('async function loadConversation(', 'window.__reviewTestRead = () => loadConversation(true, "latest");\nasync function loadConversation(')
    await route.fulfill({ response, body })
  })
  await page.goto(`${origin}${REVIEW_PREFIX}?access=${access.record.id}`)
  await page.locator('#conversationMessages [data-seq="4"]').waitFor()
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('实时更新'))
  await wait(1600)
  const idleStart = { ...requests }
  await wait(17_000)
  const idleReads = { state: requests.state - idleStart.state, conversation: requests.conversation - idleStart.conversation }
  assert.equal(idleReads.state, 0, 'healthy idle stream must not repeatedly fetch full state')
  assert.equal(idleReads.conversation, 0, 'healthy idle stream must not poll conversation')

  const frame = f => hooks.get('agent/assistant-stream')({ agent: { session: { id: 'captain', header: { origin: 'user' } } }, frame: { attemptId: 'preview', ...f } })
  frame({ type: 'start', revision: 1 })
  frame({ type: 'chunk', revision: 2, index: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING' } })
  frame({ type: 'chunk', revision: 3, index: 1, chunk: { type: 'text-delta', index: 1, text: '正在整理结论' } })
  await page.locator('.conversationStreaming').waitFor()
  assert.match(await page.locator('.conversationStreaming').innerText(), /正在整理结论/)
  assert(!(await page.locator('#conversationMessages').innerText()).includes('PRIVATE_REASONING'))
  const seq = append('assistant', '完整结论')
  await page.locator(`[data-seq="${seq}"]`).waitFor()
  assert.equal(await page.locator('.conversationStreaming').count(), 0)

  await context.setOffline(true)
  for (let i = 0; i < 75; i++) append('assistant', `离线期间消息 ${i}`)
  await context.setOffline(false)
  await page.locator(`[data-seq="${events.length - 1}"]`).waitFor({ timeout: 20_000 })
  const sequences = await page.locator('#conversationMessages [data-seq]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.seq)))
  assert.deepEqual(sequences, Array.from({ length: events.length }, (_, i) => i), 'all missed pages must be preserved in order')

  await page.locator('#conversationInput').fill('隔离测试：重试相同消息')
  await page.locator('#conversationSend').click()
  await page.waitForFunction(() => document.querySelector('#conversationSendStatus').textContent.includes('暂时无法确认'))
  await page.locator('#conversationSend').click()
  await page.waitForFunction(() => document.querySelector('#conversationInput').value === '')
  assert.equal(sends.length, 2); assert.equal(sends[0], sends[1]); assert.equal(seen.size, 1)
  assert.equal(await page.locator('#conversationMessages [data-seq]').filter({ hasText: '隔离测试：重试相同消息' }).count(), 1)

  // Hold an older HTTP snapshot while a new SSE message arrives.
  let releaseRead, readCaptured
  const captured = new Promise(resolve => { readCaptured = resolve })
  const release = new Promise(resolve => { releaseRead = resolve })
  const intercept = async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') !== 'conversation') return route.continue()
    const response = await route.fetch()
    readCaptured(); await release
    await route.fulfill({ response })
  }
  await page.route('**/api/state?*', intercept)
  await page.evaluate(() => { void window.__reviewTestRead() }); await captured
  const raced = append('assistant', '历史读取期间的新消息')
  await wait(200); releaseRead()
  await page.locator(`[data-seq="${raced}"]`).waitFor()
  assert.equal(await page.locator(`[data-seq="${raced}"]`).count(), 1)
  await page.unroute('**/api/state?*', intercept)

  const beforeStateChange = requests.state
  state.team.name = '任务状态已更新'
  await writeFile(join(root, 'team/new.json'), '{"revision":2}')
  await rename(join(root, 'team/new.json'), join(root, 'team/team.json'))
  await page.waitForFunction(() => document.title.includes('任务状态已更新'))
  assert(requests.state > beforeStateChange)

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
  assert.deepEqual(errors, [])
  await page.close()
  for (let i = 0; i < 40 && activeStreams; i++) await wait(50)
  assert.equal(activeStreams, 0)
  const fallback = await context.newPage()
  await fallback.addInitScript(() => { window.EventSource = undefined })
  fallback.on('pageerror', e => errors.push(e.message))
  const beforeFallback = requests.events
  await fallback.goto(`${origin}${REVIEW_PREFIX}?access=${access.record.id}`)
  await fallback.locator('#conversationMessages [data-seq]').first().waitFor()
  const fallbackSeq = append('assistant', '推送不可用时通过增量查询恢复')
  await fallback.locator(`[data-seq="${fallbackSeq}"]`).waitFor({ timeout: 15000 })
  assert.equal(requests.events, beforeFallback)
  await fallback.close()

  // New static assets can precede a backend restart: reject the old handshake
  // and keep ordinary incremental reads instead of trusting its replay cursor.
  const legacy = await context.newPage()
  legacy.on('pageerror', e => errors.push(e.message))
  let legacyStreams = 0
  await legacy.route('**/api/events?*', route => {
    legacyStreams++
    return route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' })
  })
  await legacy.goto(`${origin}${REVIEW_PREFIX}?access=${access.record.id}`)
  await legacy.locator('#conversationMessages [data-seq]').first().waitFor()
  const legacySeq = append('assistant', '兼容旧版后端')
  await legacy.locator(`[data-seq="${legacySeq}"]`).waitFor({ timeout: 15000 })
  assert.equal(legacyStreams, 1)
  await legacy.close()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'PASS', idleObservationSeconds: 17, idleReads, replayedMessages: 75, checks: ['real HTTP SSE', 'text-only assistant stream', 'final message replaces preview', 'offline replay over multiple pages', 'stable idempotent retry', 'atomic state change', 'mobile/desktop layout', 'connection cleanup', 'concurrent HTTP/SSE merge', 'EventSource-unavailable fallback', 'legacy-backend fallback'], requests, pageErrors: errors }, null, 2))
} finally {
  await browser.close(); disposers.forEach(fn => fn()); watch.close()
  server.closeAllConnections(); await new Promise(r => server.close(r))
  await rm(root, { recursive: true, force: true })
}
