import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepResearchStage3Fixture } from './support/deep-research-stage3-fixture.mjs'
import { inspectPdfPages, verifyPdfAudit } from '../lib/deep-research-gates.js'

test('Host PDF audit accepts only current first, middle and last page render hashes', async () => {
  const fixture = createDeepResearchStage3Fixture(['问题与反常识结论','机制与证据','情景与反方','战略收口','行动与复盘'])
  const audit = await inspectPdfPages(fixture.pdf)
  assert.equal(audit.pageCount, 3)
  await verifyPdfAudit(fixture.pdf, audit)
  await assert.rejects(verifyPdfAudit(fixture.pdf, {
    ...audit, pages: { ...audit.pages, middle: { ...audit.pages.middle, sha256: '0'.repeat(64) } },
  }), /DEEP_RESEARCH_PDF_AUDIT/)
  await assert.rejects(verifyPdfAudit(fixture.pdf, { ...audit, pageCount: 4 }), /DEEP_RESEARCH_PDF_AUDIT/)
})
