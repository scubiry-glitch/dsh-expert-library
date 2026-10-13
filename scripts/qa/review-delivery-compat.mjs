import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.REVIEW_PLAYWRIGHT_MODULE || '/usr/lib/node_modules/playwright/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({ executablePath: process.env.REVIEW_CHROMIUM || '/root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell', headless: true, args: ['--no-sandbox'] })
const task = { id: 't1', subject: '多格式成果', status: 'completed', dependencies: [] }
const doc = (id, name, extra = {}) => ({ taskId: 't1', id, name, fallback: true, createdAt: 1, ...extra })
const state = { ok: true, expiresAt: Date.now() + 86400000, plan: null, team: { id: 'compat', name: '兼容验收', members: [], tasks: [task] }, documents: [], presentation: { mode: 'generic', labels: { results: '交付成果' }, stages: { plan: 'done', outline: 'na', activity: 'done', results: 'pending' } } }
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }), errors = []
page.on('pageerror', e => errors.push(e.message))
await page.route('https://review.test/**', async route => {
  const url = new URL(route.request().url()), name = url.pathname.split('/').pop()
  if (url.pathname.includes('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(name === 'conversation' ? { ok: true, conversation: { messages: [], nextAfter: 0 } } : state) })
  const file = url.pathname.includes('/portraits/') ? 'portraits/' + name : name === 'review' ? 'index.fast.html' : name
  await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webp') ? 'image/webp' : 'text/html', body: await readFile(new URL('../../assets/review/' + file, import.meta.url)) })
})
async function display() {
  await page.reload()
  await page.locator('#content:visible').waitFor()
  await page.locator('#view-workspace').click()
  await page.locator('#tab-results').click()
}
try {
  await page.goto('https://review.test/plugins/dsh-expert-library/review?access=' + 'a'.repeat(24))
  await page.locator('#content:visible').waitFor()
  await page.locator('#view-workspace').click()
  await page.locator('#tab-results').click()
  assert.match(await page.locator('#results').innerText(), /暂无可展示的任务成果/)

  // Missing final declarations are not evidence of a failed acceptance gate.
  state.documents = [doc('old', 'memo.pdf'), doc('pdf', 'memo.pdf', { createdAt: 2 }), doc('html', 'memo.html'), doc('json', 'ledger.json'), doc('zip', 'assets.zip'), doc('output', '任务交付说明')]
  await display()
  assert.match(await page.locator('#results').innerText(), /已有任务成果/)
  assert.doesNotMatch(await page.locator('#results').innerText(), /尚未确认正式交付|尚未标记为正式交付/)
  assert.equal(await page.locator('.taskOutputs').evaluate(el => el.open), true)
  assert.equal(await page.locator('.taskOutputs .resultDocumentRow').count(), 5)
  assert.match(await page.locator('.taskOutputs').innerText(), /ledger.json/)
  assert.match(await page.locator('.taskOutputs').innerText(), /assets.zip/)
  assert.equal(await page.locator('#tab-results').getAttribute('data-complete'), 'false')
  assert.match(await page.locator('#tab-results').innerText(), /有成果/)
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`)
  }

  // Files sharing a declared result key must remain individually accessible.
  state.documents = [doc('pdf', 'memo.pdf', { resultKey: 'memo' }), doc('json', 'ledger.json', { resultKey: 'memo' })]
  await display()
  assert.equal(await page.locator('.taskOutputs .resultDocumentRow').count(), 2)
  task.status = 'in_progress'
  await display()
  assert.equal(await page.locator('.taskOutputs').count(), 0)
  assert.doesNotMatch(await page.locator('#tab-results').innerText(), /有成果/)

  task.status = 'completed'
  state.documents = [doc('pdf', 'memo.pdf', { formal: true, resultKey: 'memo', resultLabel: '决策备忘录' })]
  state.presentation.stages.results = 'done'
  await display()
  assert.match(await page.locator('.formalReport').innerText(), /正式交付/)
  assert.equal(await page.locator('.taskOutputs').count(), 0)
  assert.equal(await page.locator('#tab-results').getAttribute('data-complete'), 'true')
  assert.doesNotMatch(await page.locator('#tab-results').innerText(), /有成果/)

  // Research still reports its own pending release; availability never marks it accepted.
  state.presentation.mode = 'research'
  state.presentation.stages.results = 'pending'
  state.documents = [doc('body', 'report.md', { resultKind: 'manuscript', fallback: false })]
  await display()
  assert.match(await page.locator('#results').innerText(), /正式报告尚未交付.*可先查阅下方定稿/)
  assert.equal(await page.locator('.formalReport').count(), 0)
  assert.equal(await page.locator('#tab-results').getAttribute('data-complete'), 'false')
  assert.deepEqual(errors, [])
  console.log('PASS: legacy availability, empty state, all file formats, current revision, shared result keys, working drafts, domain acceptance, research gate, four viewport widths')
} finally { await browser.close() }
