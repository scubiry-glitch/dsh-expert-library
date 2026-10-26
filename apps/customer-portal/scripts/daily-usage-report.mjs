import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfig } from '../config.mjs'
import { createDshGateway } from '../dsh-gateway.mjs'

const backendRef = 'zhijian-demo-c'
const reportRoot = process.env.USAGE_REPORT_DIR || '/var/lib/zhijian/customer-portal/usage-reports'
const chromiumPath = process.env.USAGE_CHROMIUM || '/opt/zhijian/usage-browser/chrome-headless-shell-linux64/chrome-headless-shell'
const playwrightModule = process.env.USAGE_PLAYWRIGHT_MODULE || '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs'
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const args = new Set(process.argv.slice(2))
if ([...args].some(arg => !['--dry-run', '--send'].includes(arg)) || args.has('--dry-run') === args.has('--send')) {
  throw Error('Specify exactly one of --dry-run or --send')
}

const config = readConfig()
const origin = config.dshBackends[backendRef]
if (!origin || !config.researchEnabledBackends.includes(backendRef)) throw Error('C backend is not enabled')
const runtime = { backendRef, origin }
const usage = await createDshGateway(config).adminUsage(runtime, 7)
if (usage?.days !== 7 || !usage.rankings || !['expert', 'skill', 'pack', 'source'].every(kind => Array.isArray(usage.rankings[kind]))) {
  throw Error('Invalid usage response')
}

const date = today()
await mkdir(reportRoot, { recursive: true, mode: 0o700 })
const receiptPath = join(reportRoot, `${date}.sent.json`)
if (args.has('--send')) {
  try { await readFile(receiptPath); process.stdout.write(`already sent for ${date}\n`); process.exit(0) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

const { chromium } = await import(playwrightModule)
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] })
let image
let extension = 'png'
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/*', route => {
    const requestUrl = new URL(route.request().url())
    const sameOrigin = requestUrl.origin === `http://127.0.0.1:${config.port}`
    if (!sameOrigin) return route.abort()
    if (requestUrl.pathname === '/api/bootstrap') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      authenticated: true, researchReady: true, user: { role: 'admin', accountName: '智见账号' },
    }) })
    if (requestUrl.pathname === '/api/capabilities/settings') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      writable: false, revision: 0, value: {},
    }) })
    if (requestUrl.pathname === '/api/capabilities/usage' && requestUrl.searchParams.get('days') === '7') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(usage) })
    }
    if (requestUrl.pathname.startsWith('/api/')) return route.abort()
    return route.continue()
  })
  await page.goto(`http://127.0.0.1:${config.port}/manage#usage`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.locator('#usageCards .manageUsageCard').first().waitFor({ state: 'visible', timeout: 10_000 })
  if (await page.locator('#usageCards .manageUsageCard').count() !== 4) throw Error('Usage cards did not render')
  if (pageErrors.length) throw Error(`Report page error: ${pageErrors.join('; ')}`)
  if (await page.locator('#manageNotice').innerText()) throw Error('Usage page reported an error')
  image = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' })
  if (image.length > 2_000_000) {
    extension = 'jpg'
    image = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 76, animations: 'disabled' })
  }
  if (image.length > 2_000_000) throw Error('Screenshot exceeds WeCom image limit')
  await page.close()
} finally { await browser.close() }

const imagePath = join(reportRoot, `${date}.${extension}`)
await writeFile(imagePath, image, { mode: 0o600 })
if (args.has('--dry-run')) {
  process.stdout.write(`rendered ${imagePath} (${image.length} bytes); not sent\n`)
  process.exit(0)
}

const credentialsDir = process.env.CREDENTIALS_DIRECTORY
if (!credentialsDir) throw Error('Webhook credential is unavailable')
const webhook = (await readFile(join(credentialsDir, 'usage-webhook'), 'utf8')).trim()
const target = new URL(webhook)
if (target.protocol !== 'https:' || target.hostname !== 'qyapi.weixin.qq.com'
  || target.pathname !== '/cgi-bin/webhook/send' || target.username || target.password || target.hash
  || target.searchParams.size !== 1 || !/^[0-9a-f-]{36}$/i.test(target.searchParams.get('key') || '')) {
  throw Error('Invalid webhook credential')
}
const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'image', image: {
    base64: image.toString('base64'), md5: createHash('md5').update(image).digest('hex'),
  } }) })
if (!response.ok) throw Error(`WEBHOOK_HTTP_${response.status}`)
const result = await response.json()
if (result?.errcode !== 0) throw Error(`WEBHOOK_ERR_${Number(result?.errcode) || 'UNKNOWN'}`)
const temporary = `${receiptPath}.tmp`
await writeFile(temporary, JSON.stringify({ date, sentAt: new Date().toISOString(), image: imagePath,
  sha256: createHash('sha256').update(image).digest('hex') }), { mode: 0o600 })
await rename(temporary, receiptPath)
process.stdout.write(`sent usage ranking for ${date} (${image.length} bytes)\n`)
