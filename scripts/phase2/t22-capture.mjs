#!/usr/bin/env node
/** T2.2 browser capture: per isolated DSH instance, open 设置 → 领域包 → 来源设置
 * and save the rendered connection panel (must contain the instance deploymentId).
 * Read-only against DSH: navigation and clicks only, no DSH process is touched.
 *
 * Shell DOM notes (discovered against the real instances):
 * - The web shell requires its session token; the instance's own startup log
 *   prints the authenticated URL (last line wins). The token is never persisted.
 * - The "Settings" trigger (button[aria-label="Settings"]) sits behind a modal
 *   mask (_mask_*), so pointer-event clicks are intercepted; dispatch the DOM
 *   click instead. The dialog nav then offers a 领域包 section whose panel has
 *   nav[aria-label="领域包版本管理"] with role=tab buttons incl. 来源设置.
 */
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const tree = fileURLToPath(new URL('../../', import.meta.url))
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const webTokenLog = { A: '/tmp/inst-a.log', B: '/tmp/inst-b.log' }
const instances = [
  { id: 'A', port: 18281 },
  { id: 'B', port: 18282 },
].filter(i => !process.env.CAPTURE_INSTANCE || i.id === process.env.CAPTURE_INSTANCE)

async function webUrl(port, id) {
  let text = ''
  try { text = await readFile(webTokenLog[id], 'utf8') } catch { return `http://127.0.0.1:${port}/` }
  const lines = text.split('\n').filter(l => l.includes(`127.0.0.1:${port}`) && l.includes('token='))
  if (!lines.length) return `http://127.0.0.1:${port}/`
  const m = lines[lines.length - 1].match(/https?:\/\/\S+/)
  if (!m) return `http://127.0.0.1:${port}/`
  const token = new URL(m[0]).searchParams.get('token')
  return token ? `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}` : `http://127.0.0.1:${port}/`
}

// DOM-level click for elements a modal mask hides from pointer events.
function domClick(page, selector, wantText) {
  return page.evaluate(({ selector, wantText }) => {
    const els = [...document.querySelectorAll(selector)]
    const el = els.find(e => !wantText || e.textContent.trim() === wantText)
    if (!el) return false
    el.click()
    return true
  }, { selector, wantText })
}

async function captureInstance(browser, i, deploymentId) {
  const page = await browser.newPage()
  await page.goto(await webUrl(i.port, i.id), { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.locator('button[aria-label="Settings"]').waitFor({ state: 'visible', timeout: 20000 })
  // Dismiss the "Internal Testing Notice" modal if present so screenshots show
  // the actual connection panel.
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 2000 }).catch(() => {})
  await page.getByRole('button', { name: 'Configure later' }).click({ timeout: 2000 }).catch(() => {})

  if (!await domClick(page, 'button[aria-label="Settings"]')) throw new Error(`Instance ${i.id}: Settings trigger not found`)
  const dialogNav = page.locator('button:has-text("领域包")').first()
  await dialogNav.waitFor({ state: 'visible', timeout: 15000 })
  if (!await domClick(page, 'button', '领域包')) throw new Error(`Instance ${i.id}: 领域包 nav entry not found`)

  const nav = page.locator('nav[aria-label="领域包版本管理"]')
  await nav.waitFor({ state: 'visible', timeout: 15000 })
  const TAB = process.env.CAPTURE_TAB || '来源设置'
  if (!await domClick(page, 'nav[aria-label="领域包版本管理"] [role="tab"]', TAB)) {
    throw new Error(`Instance ${i.id}: ${TAB} tab not found`)
  }

  // The rendered panel must show this instance's bound deploymentId.
  const assertText = process.env.CAPTURE_ASSERT || deploymentId
  await page.getByText(assertText, { exact: false }).first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(500)

  const html = await page.content()
  const outPrefix = process.env.CAPTURE_OUT || `T2.2.connection`
  const htmlPath = join(dag, `${outPrefix}-${i.id}.html`)
  await writeFile(htmlPath, html, { mode: 0o600 })
  await chmod(htmlPath, 0o600)
  const pngPath = join(dag, `${outPrefix}-${i.id}.png`)
  await page.screenshot({ path: pngPath, fullPage: true })
  await chmod(pngPath, 0o600)
  await page.close()
  return { id: i.id, port: i.port, deploymentId, htmlPath, pngPath }
}

async function main() {
  const bind = JSON.parse(await readFile(join(dag, 'T2.2.bind.json'), 'utf8'))
  const { chromium } = await import('../../apps/pack-center/node_modules/playwright-core/index.mjs')
  const browser = await chromium.launch({
    executablePath: process.env.PACK_CENTER_BROWSER_EXECUTABLE || chromium.executablePath(),
    headless: true,
    args: ['--no-sandbox'],
  })
  try {
    const results = []
    for (const i of instances) {
      const row = bind.instances.find(r => r.id === i.id)
      if (!row?.deploymentId) throw new Error(`No deploymentId for instance ${i.id} in T2.2.bind.json`)
      results.push(await captureInstance(browser, i, row.deploymentId))
    }
    console.log(JSON.stringify(results))
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(String(error.message || error).slice(0, 800)); process.exitCode = 1 })
