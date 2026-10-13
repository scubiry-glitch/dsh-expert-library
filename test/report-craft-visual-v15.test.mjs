import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepResearchStage3Fixture } from './support/deep-research-stage3-fixture.mjs'
import { evaluateReportCraftV2 } from '../domain-packs/.zhijian-realestate-v15-src/checks/report-craft-checker-v2.mjs'

const names = ['问题与反常识结论','机制与证据','情景与反方','战略收口','行动与复盘']
const artifact = (f, id, value) => {
  const bytes = Buffer.from(value)
  return { id, taskId: 'fixture', attempt: 1, path: '/never-read/' + id, sha256: f.sha256(bytes), encoding: 'base64', content: bytes.toString('base64') }
}
async function check(change) {
  const f = createDeepResearchStage3Fixture(names)
  f.html = change(f.html)
  f.craftEvidence.reportSha256.html = f.sha256(f.html)
  const artifacts = [artifact(f, 'report.md', f.md), artifact(f, 'report.html', f.html), artifact(f, 'report.pdf', f.pdf), artifact(f, 'craft-evidence.json', JSON.stringify(f.craftEvidence))]
  const binding = { id: 'zhijian-report-craft-core-v2', md: 'report.md', html: 'report.html', pdf: 'report.pdf', craftEvidence: 'craft-evidence.json', materialPackId: 'zhijian-report-craft-v2', materialDigest: 'a'.repeat(64), style: 'designer-paper' }
  return evaluateReportCraftV2(artifacts, binding)
}

test('v1.5.0 browser gate blocks undersized report text', async () => {
  const results = await check(html => html.replace('font:16px/1.6', 'font:9px/1.6'))
  const browser = results.find(result => result.id === 'report-craft-browser')
  assert.equal(browser.status, 'failed', browser.detail)
  assert.match(browser.detail, /fontFailureCount/)
})

test('v1.5.0 browser gate blocks a visible dead button', async () => {
  const results = await check(html => html.replace('</main>', '<button aria-label="继续"></button></main>'))
  const browser = results.find(result => result.id === 'report-craft-browser')
  assert.equal(browser.status, 'failed', browser.detail)
  assert.match(browser.detail, /deadControlCount/)
})
