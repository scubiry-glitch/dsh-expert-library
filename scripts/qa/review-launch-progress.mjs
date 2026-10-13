// Isolated browser check: approval progress follows durable state, not elapsed time.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs'

const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell', headless: true, args: ['--no-sandbox'] })
const plan = { planId: 'plan-launch-test', digest: 'a'.repeat(64), revision: 0, status: 'staged', runtime: { teamName: '启动进度测试' }, preview: { members: [], tasks: [] } }
const state = { ok: true, expiresAt: Date.now() + 86400000, captainSessionId: 'captain', canSendMessage: true, plan, team: null, documents: [] }
let context = { ok: true, context: { planId: plan.planId, digest: plan.digest, revision: plan.revision, baselineSha256: 'b'.repeat(64), currentSha256: 'b'.repeat(64), changed: false, newMessages: [] } }
const errors = []
let writes = 0
let syncWrites = 0
const revisionMessages = []
let stateAuthFailure = false
let stateReads = 0
let actionFailure = { status: 502, error: 'REVIEW_ACTION_FAILED' }
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { window.EventSource = undefined; window.confirm = () => true })
  await page.route('https://review.test/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/api/state')) {
      stateReads++
      if (stateAuthFailure) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'REVIEW_LOGIN_REQUIRED' }) })
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.searchParams.get('view') === 'context' ? context : state) })
    }
    if (url.pathname.endsWith('/api/action')) {
      const action = route.request().postDataJSON()
      if (action.action === 'message') {
        revisionMessages.push(action)
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, accepted: true }) })
      }
      if (action.action === 'sync-context') {
        syncWrites++
        assert.equal(action.expectedContextSha256, context.context.currentSha256)
        state.plan = { ...state.plan, revision: state.plan.revision + 1, digest: 'c'.repeat(64) }
        context = { ok: true, context: { ...context.context, revision: state.plan.revision, digest: state.plan.digest, baselineSha256: context.context.currentSha256, changed: false, newMessages: [] } }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, plan: state.plan }) })
      }
      writes++
      await new Promise(resolve => setTimeout(resolve, 900))
      return route.fulfill({ status: actionFailure.status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: actionFailure.error }) })
    }
    if (url.pathname.includes('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, conversation: { messages: [], nextAfter: 0, hasMore: false } }) })
    const name = url.pathname.split('/').pop()
    const file = url.pathname.includes('/portraits/') ? `portraits/${name}` : name === 'review' ? 'index.fast.html' : name
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.webp') ? 'image/webp' : 'text/html', body: await readFile(new URL(`../../assets/review/${file}`, import.meta.url)) })
  })
  await page.goto('https://review.test/plugins/dsh-expert-library/review?access=' + 'a'.repeat(24))
  await page.locator('#content:visible').waitFor()
  await page.locator('#view-workspace').click()
  await page.locator('#tab-plan').click()
  await page.locator('#planContent button', { hasText: '确认计划并开始执行' }).click()
  await page.locator('#launchProgress:visible').waitFor()
  assert.equal(await page.locator('#launchBar').getAttribute('value'), null, 'no fabricated percentage before a durable checkpoint')
  await page.locator('#planContent button', { hasText: '等待结果核实' }).waitFor()
  assert.match(await page.locator('#launchDetail').innerText(), /正在核实确认结果/)
  assert.equal(await page.locator('#planContent button', { hasText: '等待结果核实' }).isDisabled(), true)

  await page.locator('#view-conversation').click()
  assert.equal(await page.locator('#launchProgress').isHidden(), true, 'launch progress stays in workspace only')
  state.plan = { ...plan, status: 'approved', approval: { approvedAt: Date.now() } }
  await page.waitForFunction(() => document.querySelector('#launchCount')?.textContent?.startsWith('1/3'), null, { timeout: 12000 })
  assert.equal(await page.locator('#launchProgress').isHidden(), true, 'polling must not reveal progress in conversation')
  await page.locator('#view-workspace').click()
  await page.locator('#launchProgress:visible').waitFor()
  state.plan = { ...state.plan, status: 'running' }
  await page.waitForFunction(() => document.querySelector('#launchCount')?.textContent?.startsWith('2/3'), null, { timeout: 12000 })
  state.plan = { ...state.plan, status: 'completed', appliedTeamId: 'team-launch-test' }
  state.team = { id: 'team-launch-test', captainSessionId: 'captain', name: '启动进度测试', members: [], tasks: [] }
  await page.waitForFunction(() => document.querySelector('#launchCount')?.textContent?.startsWith('3/3'), null, { timeout: 12000 })
  assert.equal(await page.locator('#launchBar').getAttribute('value'), '3')
  assert.equal(await page.locator('[data-launch-step][data-state="done"]').count(), 3)
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`)
  }
  assert.equal(writes, 1, 'uncertain response must not trigger duplicate approval')
  // A newer direct-user input must not be mislabeled as a plan revision conflict.
  state.plan = plan; state.team = null
  actionFailure = { status: 400, error: 'SHARED_TASK_CONTEXT_CHANGED' }
  await page.reload()
  await page.locator('#content:visible').waitFor()
  await page.locator('#view-workspace').click()
  await page.locator('#tab-plan').click()
  await page.locator('#planContent button', { hasText: '确认计划并开始执行' }).click()
  await page.getByText('计划创建后收到了新的用户输入。', { exact: false }).first().waitFor()
  assert(!(await page.locator('#error').innerText()).includes('内容已有更新'))
  assert.equal(writes, 2)
  context = { ok: true, context: { ...context.context, currentSha256: 'd'.repeat(64), changed: true, newMessages: [{ id: 'u2', seq: 2, text: '新增输入，原计划仍适用' }] } }
  await page.reload()
  await page.locator('#content:visible').waitFor()
  await page.locator('#view-workspace').click()
  await page.locator('#tab-plan').click()
  await page.getByText('新增输入，原计划仍适用').waitFor()
  assert.equal(await page.locator('#planContent button', { hasText: '确认计划并开始执行' }).isDisabled(), true)
  await page.getByRole('button', { name: '请队长修订计划' }).click()
  await page.getByText('修订请求已送达队长', { exact: false }).first().waitFor()
  assert.equal(revisionMessages.length, 1)
  assert.match(revisionMessages[0].text, /不要替我确认启动/)
  assert.equal(state.plan.status, 'staged')
  await page.locator('#view-workspace').click()
  await page.locator('#tab-plan').click()
  await page.getByRole('button', { name: '原计划仍适用，生成新版' }).click()
  await page.getByText('版本 r1', { exact: false }).first().waitFor()
  assert.equal(syncWrites, 1)
  assert.equal(state.plan.status, 'staged', 'context sync must not approve or launch')
  actionFailure = { status: 502, error: 'REVIEW_ACTION_FAILED' }
  await page.locator('#planContent button', { hasText: '确认计划并开始执行' }).waitFor({ state: 'visible' })
  await page.locator('#planContent button', { hasText: '确认计划并开始执行' }).click()
  await page.locator('#planContent button', { hasText: '等待结果核实' }).waitFor()
  stateAuthFailure = true
  await page.locator('#login:visible').waitFor({ timeout: 12000 })
  assert.match(await page.locator('#error').innerText(), /访问已失效，启动结果尚未核实/)
  const readsAfterExpiry = stateReads
  await page.waitForTimeout(5000)
  assert.equal(stateReads, readsAfterExpiry, 'expired access stops launch polling')
  assert.deepEqual(errors, [])
  console.log('PASS: durable launch checkpoints, reviewed context-only revision, expired access stops polling, no duplicate approval or page errors')
} finally { await browser.close() }
