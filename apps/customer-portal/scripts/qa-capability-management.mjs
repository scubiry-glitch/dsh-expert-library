import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.CUSTOMER_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs')
const dist = new URL('../dist/', import.meta.url)
const json = value => JSON.stringify(value)
const postedOperations = []
const postedSettings = []
const release = (releaseId, packId, version, name) => ({ releaseId, packId, version, name,
  manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), contentTreeSha256: 'c'.repeat(64),
  compatibility: { compatible: true, reasons: [] }, downloadAvailability: { available: true } })
const fixtures = {
  settings: { writable: true, revision: 1, value: { providers: { localdb: { scanDirs: ['/data'] }, wind: { cliPath: '/usr/local/bin/wind' },
    zyt: { baseUrl: 'https://zyt.example', preferCli: true } }, toolExecution: {}, packCenterUpdatePolicy: { mode: 'manual' },
    defaultModel: { provider: 'openai', model: 'gpt-5' }, expertModelOverrides: {} } },
  models: { models: [
    { provider: 'openai', model: 'gpt-5', name: 'GPT 5', reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] },
    { provider: 'anthropic', model: 'claude-sonnet', name: 'Claude Sonnet', reasoningEfforts: [{ id: 'high', name: '高' }] },
  ] },
  health: { providers: { wind: { registered: true, keyPresent: false }, zyt: { registered: true, keyPresent: true, reachable: true },
    beike: { registered: true, keyPresent: true, reachable: true }, localdb: { registered: true, databases: [] } } },
  packs: { packs: [{ id: 'zhijian-realestate', name: '智见房产', version: '1.0.0', layer: 'builtin', ok: true }] },
  'center-connection': { configured: true, activationAvailable: true, connection: { bound: true, centerId: 'sample' }, revision: 2 },
  'center-installations': { mode: 'normal', generation: 7, items: [
    { releaseId: 'release-current', packId: 'zhijian-realestate', version: '1.6.17', active: true, source: 'center', integrity: 'verified' },
    { releaseId: 'release-old', packId: 'zhijian-realestate', version: '1.6.14', active: false, source: 'center', integrity: 'verified' },
    { releaseId: 'bank-current', packId: 'bank-finance', version: '1.2.4', active: true, source: 'center', integrity: 'verified' },
  ] },
  'center-updates': { generation: 7, stale: false, items: [] },
  'center-catalog': { stale: false, items: [
    release('release-current', 'zhijian-realestate', '1.6.17', '智见房产'),
    release('release-next', 'zhijian-realestate', '1.6.18', '智见房产'),
    release('bank-current', 'bank-finance', '1.2.4', '银行金融'),
    release('medical-new', 'medical-research', '2.0.0', '医药研究'),
  ] }, 'center-operations': [],
  'managed-experts': { ok: true, experts: [] }, 'managed-scenarios': { ok: true, scenarios: [] },
  experts: { experts: [{ id: 'expert-one', name: '研究专家', effective: { provider: 'openai', model: 'gpt-5' }, source: 'default' }] },
  skills: { skills: [] },
  usage: { days: 7, asOf: Date.parse('2026-10-26T00:00:00Z'), firstEventAt: Date.parse('2026-10-25T00:00:00Z'),
    rankings: { expert: [{ id: 'expert-one', version: '1.0.0', calls: 3, sessions: 2 }],
      skill: [{ id: 'skill-one', calls: 2, sessions: 1 }], pack: [], source: [{ id: 'zyt', calls: 4, sessions: 2 }] } },
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/api/capabilities/center-operations' && req.method === 'POST') {
    const parts = []
    for await (const part of req) parts.push(part)
    postedOperations.push(JSON.parse(Buffer.concat(parts).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(json({ operationId: 'sample-operation', status: 'queued' }))
    return
  }
  if (path === '/api/capabilities/settings' && req.method === 'PUT') {
    const parts = []
    for await (const part of req) parts.push(part)
    const input = JSON.parse(Buffer.concat(parts).toString('utf8'))
    postedSettings.push(input)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(json({ revision: input.revision + 1, value: input.value }))
    return
  }
  if (path === '/api/bootstrap' || path.startsWith('/api/capabilities/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(json(path === '/api/bootstrap' ? { authenticated: true, researchReady: true,
      user: { role: 'admin', accountName: '测试账号' } } : fixtures[path.slice('/api/capabilities/'.length)] ?? {}))
    return
  }
  const local = path === '/manage' ? 'manage.html' : path.startsWith('/assets/') ? path.slice('/assets/'.length) : path.slice(1)
  if (!/^(manage\.html|(?:style|manage)\.(?:css|js)|favicon\.ico)$/.test(local)) { res.writeHead(404); res.end(); return }
  try {
    const bytes = await readFile(new URL(local, dist))
    res.writeHead(200, { 'content-type': local.endsWith('.js') ? 'text/javascript' : local.endsWith('.css') ? 'text/css' : 'text/html' })
    res.end(bytes)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright')
const availableBrowsers = await readdir(browserRoot).catch(() => [])
const browserCandidates = [process.env.CUSTOMER_CHROMIUM, chromium.executablePath(),
  ...availableBrowsers.filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
    .map(name => join(browserRoot, name, 'chrome-headless-shell-linux64/chrome-headless-shell'))].filter(Boolean)
let browserPath
for (const candidate of browserCandidates) {
  try { await access(candidate); browserPath = candidate; break } catch { /* try next installed browser */ }
}
if (!browserPath) throw new Error('Chromium is unavailable; set CUSTOMER_CHROMIUM to an installed executable')
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
try {
  for (const width of [1440, 960, 390, 320]) {
    postedOperations.length = 0
    postedSettings.length = 0
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => void dialog.accept())
    await page.goto(`http://127.0.0.1:${server.address().port}/manage`, { waitUntil: 'networkidle' })
    await page.locator('#manageContent').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
      throw new Error(`${error.message}\naccess=${await page.locator('#accessState').textContent()}\npageErrors=${errors.join('; ')}`)
    })
    assert.deepEqual(errors, [])
    assert.equal(await page.locator('.manageSection').count(), 4)
    assert.equal(await page.locator('#tab-data').getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#data').isVisible(), true)
    assert.equal(await page.locator('#packs').isHidden(), true)
    assert.equal(await page.locator('#experts').isHidden(), true)
    assert.equal(await page.locator('.manageSourceCard').count(), 4)
    assert.equal(await page.locator('.manageSourceCard[data-source="wind"]').getAttribute('aria-pressed'), 'true')
    await page.locator('.manageSourceCard[data-source="zyt"]').click()
    assert.equal(await page.locator('#dataFormTitle').innerText(), '政研通配置')
    assert.equal(await page.locator('#dataForm label[data-source="wind"]').isHidden(), true)
    assert.equal(await page.locator('#dataForm label[data-source="zyt"]').first().isVisible(), true)
    await page.locator('#dataForm [name="zytBaseUrl"]').fill('https://zyt-new.example')
    await page.locator('#dataForm button[type="submit"]').click()
    await page.getByText('政研通配置已保存。').waitFor()
    assert.equal(postedSettings.at(-1).section, 'providers')
    assert.equal(postedSettings.at(-1).value.wind.cliPath, '/usr/local/bin/wind')
    assert.equal(postedSettings.at(-1).value.zyt.baseUrl, 'https://zyt-new.example')
    assert.equal(Object.hasOwn(postedSettings.at(-1).value, 'localdb'), false)
    await page.locator('.manageSourceCard[data-source="localdb"]').click()
    assert.equal(await page.locator('#localDataNote').isVisible(), true)
    assert.equal(await page.locator('#dataForm').isHidden(), true)
    await page.locator('.manageSourceCard[data-source="wind"]').click()
    await page.screenshot({ path: `/tmp/zhijian-manage-data-${width}.png`, fullPage: true })
    await page.goto(`http://127.0.0.1:${server.address().port}/manage#packs`, { waitUntil: 'networkidle' })
    assert.equal(await page.locator('#tab-packs').getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('#data').isHidden(), true)
    assert.equal(await page.locator('#packs').isVisible(), true)
    assert.equal(await page.locator('#packs .manageSubnav').isVisible(), width >= 960)
    if (width >= 960) {
      await page.locator('#packs .manageSubnav [data-scroll-target="pack-catalog"]').click()
      await page.waitForFunction(() => document.querySelector('#packs .manageSubnav [data-scroll-target="pack-catalog"]')
        .getAttribute('aria-current') === 'location')
      assert.equal(new URL(page.url()).hash, '#packs')
      assert.equal(await page.locator('#pack-catalog').isVisible(), true)
    }
    assert.equal(await page.locator('#localPacks').getByText('智见房产').count(), 1)
    assert.equal(await page.locator('#installedPacks .managePackGroup').count(), 2)
    assert.equal(await page.locator('#catalogPacks .managePackGroup').count(), 2)
    assert.equal(await page.locator('#catalogStatus').innerText(), '可安装 2 个版本，涉及 2 个领域包。')
    assert.equal(await page.locator('#perPackPolicies select[data-pack-id="zhijian-realestate"]').count(), 1)
    const realestate = page.locator('#installedPacks .managePackGroup[data-pack-id="zhijian-realestate"]')
    assert.equal(await realestate.locator('summary').innerText(), '智见房产\nzhijian-realestate\n当前 v1.6.17\n已安装 2 个版本\n⌄')
    assert.equal(await realestate.getAttribute('open'), null)
    await realestate.locator('summary').click()
    assert.equal(await realestate.locator('.managePackVersion').count(), 2)
    assert.deepEqual(await realestate.locator('.managePackVersionInfo strong').allTextContents(),
      ['v1.6.17当前启用', 'v1.6.14已安装'])
    await realestate.locator('.managePackVersion').filter({ hasText: 'v1.6.14' }).getByRole('button', { name: '切换到此版本' }).click()
    await page.getByText('操作已提交，请在下方查看结果或刷新版本状态。').waitFor()
    assert.equal(postedOperations.length, 1)
    assert.equal(postedOperations[0].kind, 'enable')
    assert.equal(postedOperations[0].releaseId, 'release-old')
    assert.equal(postedOperations[0].expectedGeneration, 7)
    assert.equal(await realestate.getAttribute('open'), '')
    const catalogRealestate = page.locator('#catalogPacks .managePackGroup[data-pack-id="zhijian-realestate"]')
    await catalogRealestate.locator('summary').click()
    assert.deepEqual(await catalogRealestate.locator('.managePackVersionInfo strong').allTextContents(), ['v1.6.18可安装'])
    await catalogRealestate.locator('.managePackVersion').filter({ hasText: 'v1.6.18' }).getByRole('button', { name: '安装并切换' }).click()
    await page.getByText('操作已提交，请在下方查看结果或刷新版本状态。').waitFor()
    assert.equal(postedOperations.length, 2)
    assert.equal(postedOperations[1].kind, 'update_enable')
    assert.equal(postedOperations[1].releaseId, 'release-next')
    assert.equal(postedOperations[1].expectedGeneration, 7)
    assert.equal(postedOperations[1].connectionRevision, 2)
    assert.deepEqual(postedOperations[1].target, { manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), contentTreeSha256: 'c'.repeat(64) })
    const newPack = page.locator('#catalogPacks .managePackGroup[data-pack-id="medical-research"]')
    assert.match(await newPack.locator('summary').innerText(), /新领域包/)
    await page.locator('#policyForm select[name="mode"]').selectOption('download')
    assert.equal(await page.locator('#policyForm button[type="submit"]').isEnabled(), true)
    assert.match(await page.locator('#policyStatus').innerText(), /策略已修改/)
    await page.locator('#policyForm button[type="submit"]').click()
    await page.getByText('更新策略已保存。').first().waitFor()
    assert.equal(postedSettings.at(-1).section, 'packCenterUpdatePolicy')
    assert.equal(postedSettings.at(-1).value.mode, 'download')
    await page.screenshot({ path: `/tmp/zhijian-manage-packs-${width}.png`, fullPage: true })
    await page.locator('#tab-experts').click()
    await page.waitForFunction(() => document.getElementById('tab-experts').getAttribute('aria-selected') === 'true')
    assert.equal(new URL(page.url()).hash, '#experts')
    assert.equal(await page.locator('#packs').isHidden(), true)
    assert.equal(await page.locator('#experts').isVisible(), true)
    assert.equal(await page.locator('#experts .manageSubnav').isVisible(), width >= 960)
    assert.equal(await page.locator('#expertRoutes').getByText('研究专家').count(), 1)
    assert.equal(await page.locator('#modelForm [name="provider"]').inputValue(), 'openai')
    await page.locator('#modelForm [name="provider"]').selectOption('anthropic')
    await page.locator('#modelForm [name="model"]').selectOption('claude-sonnet')
    await page.locator('#modelForm [name="reasoningEffort"]').selectOption('high')
    await page.locator('#modelForm button[type="submit"]').click()
    await page.getByText('默认模型已保存。').waitFor()
    assert.deepEqual(postedSettings.at(-1).value, { provider: 'anthropic', model: 'claude-sonnet', reasoningEffort: 'high' })
    await page.locator('#overrideForm [name="id"]').selectOption('expert-one')
    await page.locator('#overrideForm [name="provider"]').selectOption('openai')
    await page.locator('#overrideForm [name="model"]').selectOption('gpt-5')
    await page.locator('#overrideForm [name="reasoningEffort"]').selectOption('low')
    await page.locator('#overrideForm button[type="submit"]').click()
    await page.getByText('专家路由覆盖已保存。').waitFor()
    assert.deepEqual(postedSettings.at(-1).value['expert-one'], { provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' })
    await page.screenshot({ path: `/tmp/zhijian-manage-experts-${width}.png`, fullPage: true })
    await page.locator('#tab-usage').click()
    await page.waitForFunction(() => document.getElementById('tab-usage').getAttribute('aria-selected') === 'true')
    assert.equal(await page.locator('#usage').isVisible(), true)
    assert.equal(await page.locator('#usageCards .manageUsageCard').count(), 4)
    assert.match(await page.locator('#usageCards').innerText(), /expert-one/)
    assert.match(await page.locator('#usageCards').innerText(), /政研通/)
    await page.screenshot({ path: `/tmp/zhijian-manage-usage-${width}.png`, fullPage: true })
    await page.goBack()
    await page.waitForFunction(() => document.getElementById('tab-experts').getAttribute('aria-selected') === 'true')
    await page.locator('#tab-experts').focus()
    await page.keyboard.press('ArrowLeft')
    await page.waitForFunction(() => document.getElementById('tab-packs').getAttribute('aria-selected') === 'true')
    assert.equal(new URL(page.url()).hash, '#packs')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
    await page.close()
  }
  process.stdout.write('管理页 1440/960/390/320px 数据源选择、模型下拉、版本归组与切换、使用分析、页内导航、直链、键盘及布局检查通过\n')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
