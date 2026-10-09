/** Actual Chromium + real center/OIDC/PostgreSQL/HTTPS Git + real host API.
 * The containing React test shell is deliberately not a real DSH instance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createHostBrowserFixture } from '../support/host-browser-fixture.mjs'

const prefix = '/plugins/dsh-expert-library/manage/center'
const screenshotRoot = process.env.PACK_CENTER_HOST_BROWSER_SCREENSHOTS ? resolve(process.env.PACK_CENTER_HOST_BROWSER_SCREENSHOTS)
  : fileURLToPath(new URL('../../../../artifacts/pack-center/p5-host-ui/', import.meta.url))

test('Chromium manages a real signed release through four protected host tabs and persistent operation progress', { timeout: 300000 }, async t => {
  const fixture = await createHostBrowserFixture(t)
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.PACK_CENTER_BROWSER_EXECUTABLE || chromium.executablePath(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--host-resolver-rules=MAP host-browser.test 127.0.0.1'],
  })
  t.after(() => browser.close())
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const pageErrors = [], secretUrls = []
  page.on('pageerror', error => pageErrors.push(`${error.name}: ${error.message.replaceAll(fixture.manageToken, '[redacted]').replaceAll(fixture.bindingCode, '[redacted]').replace(/dpc_(?:bind|token)_[A-Za-z0-9_-]+/g, '[redacted]')}`))
  page.on('request', request => { if ([fixture.manageToken, fixture.bindingCode].some(secret => request.url().includes(secret))) secretUrls.push(new URL(request.url()).pathname) })
  await mkdir(screenshotRoot, { recursive: true })
  async function capture(name) {
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0) })
    const visible = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('input,textarea')].map(element => element.value).join('\n'))
    for (const secret of [fixture.manageToken, fixture.bindingCode]) assert.equal(visible.includes(secret), false, 'Secret fields must be cleared before screenshots')
    assert.equal(/dpc_(?:bind|token)_[A-Za-z0-9_-]{43}|BEGIN PRIVATE KEY/.test(visible), false, 'Machine secrets must never appear in the page')
    await page.screenshot({ path: join(screenshotRoot, `${name}.png`), fullPage: true })
  }
  async function applyToken(token = fixture.manageToken) {
    const details = page.locator('details').filter({ hasText: '本地管理权限' })
    if (!await details.evaluate(node => node.open)) await details.locator('summary').click()
    await page.getByLabel('本地管理令牌（可选）', { exact: true }).fill(token)
    const reply = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/connection`)
    await page.getByRole('button', { name: '应用管理令牌', exact: true }).click()
    assert.equal((await reply).status(), token === fixture.manageToken ? 200 : 403)
    assert.equal(await page.getByLabel('本地管理令牌（可选）', { exact: true }).inputValue(), '')
  }
  async function tab(name) { await page.getByRole('tab', { name, exact: true }).click(); await page.getByRole('tabpanel', { name, exact: true }).waitFor() }
  async function waitOperation(kind, outcome = 'succeeded') {
    await page.waitForFunction(({ kind, outcome }) => [...document.querySelectorAll('[aria-label="异步操作进度"] li')].some(element =>
      element.innerText.includes(kind) && element.innerText.includes(outcome === 'succeeded' ? '成功' : outcome)), { kind, outcome })
  }
  async function action(button, kind) {
    await button.click()
    await page.getByRole('region', { name: '操作确认', exact: true }).waitFor()
    const response = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/operations` && response.request().method() === 'POST')
    await page.getByRole('button', { name: '确认执行', exact: true }).click()
    const result = await response
    assert.equal(result.status(), 202)
    const request = result.request().postDataJSON()
    assert.equal(request.kind, kind)
    return { request }
  }
  await page.goto(fixture.hostOrigin)
  try { await page.getByRole('alert').filter({ hasText: 'MANAGE_UNAUTHORIZED' }).first().waitFor() }
  catch (error) {
    t.diagnostic(`Initial page failure: ${JSON.stringify(pageErrors)}; management request count ${fixture.requests.filter(item => item.path.startsWith(prefix)).length}`)
    throw error
  }
  assert.equal(await page.getByText('浏览器真实领域包', { exact: true }).count(), 0)
  await capture('01-protected-management')
  await applyToken()
  await tab('来源设置')
  await page.getByLabel('独立核对的中心 ID', { exact: true }).fill(fixture.administratorTrust.centerId)
  await page.getByLabel('一次性绑定码', { exact: true }).fill(fixture.bindingCode)
  await page.getByLabel('公钥 ID', { exact: true }).fill('browser-key')
  await page.getByLabel('公钥 PEM（仅 PUBLIC KEY）', { exact: true }).fill(fixture.administratorTrust.trustedSigningKeys['browser-key'])
  assert.equal(await page.getByRole('button', { name: '确认绑定', exact: true }).isDisabled(), true)
  await page.getByLabel('已通过独立渠道核对中心和公钥', { exact: true }).check()
  const binding = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/bind`)
  await page.getByRole('button', { name: '确认绑定', exact: true }).click()
  assert.equal((await binding).status(), 200)
  await page.getByText('中心已绑定', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('一次性绑定码', { exact: true }).inputValue(), '')
  await capture('02-bound-source-and-pins')

  await tab('领域包目录')
  await page.getByRole('heading', { name: '浏览器真实领域包', exact: true }).waitFor()
  await page.getByRole('button', { name: '查看详情', exact: true }).click()
  await page.getByRole('region', { name: '发布详情', exact: true }).waitFor()
  await page.locator('pre').filter({ hasText: 'Literal release notes.' }).waitFor()
  assert.equal(await page.locator('img[src="x"]').count(), 0)
  assert.equal(await page.evaluate(() => globalThis.__hostUiXss), undefined)
  await capture('03-catalog-and-fixed-detail')
  const install = await action(page.getByRole('button', { name: '安装到缓存', exact: true }), 'install')
  assert.equal(install.request.releaseId, fixture.releaseId)
  assert.match(install.request.target.manifestSha256, /^[a-f0-9]{64}$/)
  await waitOperation('安装到缓存')
  await tab('已安装')
  await page.getByText('已缓存 / 未启用', { exact: true }).waitFor()
  assert.equal((await fixture.manager.activeSnapshot()).packs.length, 0, 'Install must only cache')
  await capture('04-installed-cache-and-progress')

  // Reload loses the memory-only management token, but recovers the same durable
  // operation after explicit reauthentication without creating another install.
  const installPosts = fixture.requests.filter(item => item.path === `${prefix}/operations` && item.method === 'POST').length
  await page.reload()
  await page.getByRole('alert').filter({ hasText: 'MANAGE_UNAUTHORIZED' }).first().waitFor()
  await applyToken()
  await waitOperation('安装到缓存')
  assert.equal(fixture.requests.filter(item => item.path === `${prefix}/operations` && item.method === 'POST').length, installPosts)
  await tab('已安装')
  await page.getByText('已缓存 / 未启用', { exact: true }).waitFor()
  await action(page.getByRole('button', { name: '启用此版本', exact: true }), 'enable')
  await waitOperation('启用')
  await page.getByText('已启用', { exact: true }).waitFor()
  assert.equal((await fixture.manager.activeSnapshot()).packs[0].releaseId, fixture.releaseId)
  await capture('05-explicit-enabled-version')

  await tab('更新')
  const updates = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/check-updates`)
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  assert.equal((await updates).status(), 200)
  await page.getByText('当前可见范围内无可用更新。', { exact: true }).waitFor()
  await capture('06-explicit-update-check')
  await page.setViewportSize({ width: 320, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await capture('07-mobile-320-updates')
  await tab('来源设置')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await capture('08-mobile-320-source')
  await page.setViewportSize({ width: 1280, height: 1000 })

  // Real center denial, not a fake response: stale successful snapshots must not
  // turn into empty/latest claims, and the already active local package remains.
  await fixture.disableDeployment()
  await tab('更新')
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByText('上次检查无可用更新；当前尚未确认。', { exact: true }).waitFor()
  assert.equal(await page.getByText('当前可见范围内无可用更新。', { exact: true }).count(), 0)
  assert.equal((await fixture.manager.activeSnapshot()).packs[0].releaseId, fixture.releaseId)
  await capture('09-denied-check-keeps-stale-snapshot')

  // Switching authority unmounts all privileged state. A failed new authority
  // cannot leave the prior private catalog or deployment visible in the DOM.
  await applyToken('deliberately-invalid-memory-token')
  await page.getByRole('alert').filter({ hasText: 'MANAGE_UNAUTHORIZED' }).first().waitFor()
  assert.equal(await page.getByRole('heading', { name: '浏览器真实领域包', exact: true }).count(), 0)
  assert.equal(await page.getByText(fixture.releaseId, { exact: true }).count(), 0)
  await applyToken()
  await tab('来源设置')
  await page.getByRole('button', { name: '解绑此部署', exact: true }).click()
  await page.getByRole('region', { name: '解绑确认', exact: true }).waitFor()
  const unbinding = page.waitForResponse(response => new URL(response.url()).pathname === `${prefix}/unbind`)
  await page.getByRole('button', { name: '确认解绑', exact: true }).click()
  assert.equal((await unbinding).status(), 200)
  await page.getByText('已解绑；保留本地可信公钥和包', { exact: true }).waitFor()
  assert.equal((await fixture.manager.activeSnapshot()).packs[0].releaseId, fixture.releaseId)
  await capture('10-unbound-offline-preserved')
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  assert.equal(storage === '{"local":{},"session":{}}', true, 'The card must not write browser storage')
  assert.deepEqual(secretUrls, [])
  assert.deepEqual(pageErrors, [])
  assert.equal(await page.getByRole('region', { name: '异步操作进度', exact: true }).getByText(/阶段：已完成/).count() > 0, true)
  assert.ok(fixture.requests.filter(item => item.path.startsWith(prefix)).every(item => item.ui))
  const receipts = await fixture.manager.operations()
  assert.equal(receipts.filter(item => item.request.kind === 'install').length, 1)
  assert.equal(receipts.filter(item => item.request.kind === 'enable').length, 1)
  const privateBytes = await readFile(join(fixture.hostRoot, 'private', 'connection.json'), 'utf8')
  assert.equal(privateBytes.includes(fixture.bindingCode), false)
})
