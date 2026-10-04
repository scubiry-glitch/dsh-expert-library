import test from 'node:test'
import assert from 'node:assert/strict'
import { markdownReviewBlocks, hasMarkdownReviewQuote } from '../lib/markdown-review-quotes.js'
import { validateIndependentReview, INDEPENDENT_REVIEW_AREA_IDS } from '../lib/quality-run.js'

const matches = (source, quote) => hasMarkdownReviewQuote(markdownReviewBlocks(source), quote)

test('R11 reproduction: literal identifiers match, destructive punctuation normalization does not', () => {
  const source = 'Source ACME_DATA_V2 remains unavailable.'
  assert.equal(matches(source, source), true)
  for (const quote of ['Source ACMEDATAV2 remains unavailable.', 'Source ACME_DATA_V3 remains unavailable.']) assert.equal(matches(source, quote), false)
})

test('inline code has both exact source and visible anchors without losing literal punctuation', () => {
  const source = 'Source `ACME_DATA_V2` remains unavailable.'
  assert.equal(matches(source, source), true)
  assert.equal(matches(source, 'Source ACME_DATA_V2 remains unavailable.'), true)
  assert.equal(matches(source, 'ACMEDATAV2'), false)
  assert.equal(matches(source, '`ACME_DATA_V3`'), false)
})

for (const [source, visible] of [
  ['Strong **ACME_DATA_V2** and _emphasis_.', 'Strong ACME_DATA_V2 and emphasis.'],
  ['Escaped \\_literal\\_ and \\*literal\\*.', 'Escaped _literal_ and *literal*.'],
  ['Read [the source](https://example.com "private title") carefully.', 'Read the source carefully.'],
  ['Entity &amp; café.', 'Entity & cafe\u0301.'],
  ['A short\nwrapped paragraph.', 'A short wrapped paragraph.'],
  ['# Heading\n\nA following paragraph.', 'Heading A following paragraph.'],
  ['- Alpha claim.', 'Alpha claim.'],
  ['- Alpha claim.\n- Beta claim.', 'Alpha claim. Beta claim.'],
  ['1. First claim.\n2. Second claim.', 'First claim. Second claim.'],
  ['> First claim.\n> Second claim.', 'First claim. Second claim.'],
  ['> First claim.\n>\n> Second claim.', 'First claim. Second claim.'],
  ['- **First** claim.\n  - Nested `ACME_DATA_V2` claim.', 'First claim. Nested ACME_DATA_V2 claim.'],
]) test(`Markdown source and visible text: ${source.slice(0, 35)}`, () => {
  assert.equal(matches(source, source), true)
  assert.equal(matches(source, visible), true)
})

for (const source of [
  '---\nprivate: hidden claim\n---\n\nVisible prose.',
  '```text\nhidden claim\n```\n\nVisible prose.',
  '~~~\nhidden claim\n~~~\n\nVisible prose.',
  '    hidden claim\n\nVisible prose.',
  '<!-- hidden claim -->\n\nVisible prose.',
  '<div hidden>hidden claim</div>\n\nVisible prose.',
  '<div hidden>\n\nhidden claim\n\n</div>\n\nVisible prose.',
  '<div hidden><section>\n\nhidden claim\n\n</section></div>\n\nVisible prose.',
  '<script>hidden claim</script>\n\nVisible prose.',
  '<style>hidden claim</style>\n\nVisible prose.',
  'Visible <span hidden>hidden claim</span> prose.',
  'Read [visible](https://example.com "hidden claim").',
  '[ref]: https://example.com "hidden claim"\n\nVisible prose.',
  '![hidden claim](https://example.com/image.png)\n\nVisible prose.',
]) test(`hidden/code/metadata cannot supply a prose quote: ${source.slice(0, 38)}`, () => {
  assert.equal(matches(source, 'hidden claim'), false)
})

test('HTML boundaries preserve later prose, unclosed non-void elements exclude ambiguous remainder', () => {
  assert.equal(matches('<div hidden>\n\nhidden claim\n\n</div>\n\nVisible prose.', 'Visible prose.'), true)
  assert.equal(matches('<div hidden/>\n\nhidden claim', 'hidden claim'), false)
  assert.equal(matches('<div hidden>\n\nhidden claim', 'hidden claim'), false)
})

test('nested container prose cannot absorb a hidden or code-only quote', () => {
  for (const source of ['> First claim.\n>\n>     hidden claim\n>\n> Last claim.', '- Visible claim.\n\n  ```\n  hidden claim\n  ```', '> <div hidden>\n>\n> hidden claim\n>\n> </div>']) {
    assert.equal(matches(source, 'hidden claim'), false)
    assert.equal(matches(source, 'First claim. Last claim.'), false)
  }
})

for (const middle of ['```\nsecret\n```', '<!-- private -->', '    secret', '![alt](image.png)', '<div hidden>private</div>']) {
  test(`excluded block is not deleted to fabricate adjacency: ${middle}`, () => assert.equal(matches(`Alpha\n\n${middle}\n\nOmega`, 'Alpha Omega'), false))
}

function review(source) {
  const check = { id: 'zhijian-report-craft-core-v2', md: 'published:report.md' }
  return {
    contract: { artifactChecks: [check] },
    evidence: { artifacts: [{ id: check.md, content: source }], independentReview: {
      materialReceiptId: 'prepared', reviewerSessionId: 'reviewer',
      areas: INDEPENDENT_REVIEW_AREA_IDS.map(id => ({ id, status: 'passed', coverage: 'Current fixed report examined',
        evidence: [{ artifactId: check.md, quote: source, reason: 'Located report passage' }] })),
    } },
  }
}

test('one validation returns every quote location error and allowed Markdown identities, without report text', () => {
  const { contract, evidence } = review('Source ACME_DATA_V2 remains unavailable.')
  evidence.independentReview.areas[0].evidence[0].quote = 'altered ACME_DATA_V3'
  evidence.independentReview.areas[1].evidence.push({ artifactId: 'published:ledger.json', quote: 'summary', reason: 'Machine summary' })
  evidence.independentReview.areas[3].evidence[0].artifactId = 'published:report.html'
  assert.throws(() => validateIndependentReview(contract, evidence, true, true), error => {
    assert.equal(error.code, 'independent_review_quote_missing')
    assert.deepEqual(error.details.issues.map(({ areaId, evidenceIndex, reason }) => [areaId, evidenceIndex, reason]), [
      [INDEPENDENT_REVIEW_AREA_IDS[0], 0, 'quote_not_found'],
      [INDEPENDENT_REVIEW_AREA_IDS[1], 1, 'unsupported_artifact'],
      [INDEPENDENT_REVIEW_AREA_IDS[3], 0, 'unsupported_artifact'],
    ])
    for (const issue of error.details.issues) {
      assert.deepEqual(issue.allowedMarkdownArtifactIds, ['published:report.md'])
      assert.ok(error.message.includes(`${issue.areaId}[${issue.evidenceIndex}]`))
    }
    assert.equal(JSON.stringify(error.details).includes('ACME_DATA_V3'), false)
    return true
  })
})

test('short valid quotes remain valid; quote length and overall schema limits still apply', () => {
  const { contract, evidence } = review('好')
  assert.doesNotThrow(() => validateIndependentReview(contract, evidence, true, true))
  evidence.independentReview.areas[0].evidence[0].quote = 'a'.repeat(2001)
  assert.throws(() => validateIndependentReview(contract, evidence, true, true), { code: 'independent_review_invalid' })
})

test('located negative review is accepted as evidence, never as a passing review', () => {
  const { contract, evidence } = review('Source `ACME_DATA_V2` remains unavailable.')
  evidence.independentReview.areas[0].status = 'failed'
  assert.doesNotThrow(() => validateIndependentReview(contract, evidence, true, false))
  assert.throws(() => validateIndependentReview(contract, evidence, true, true), { code: 'independent_review_failed' })
})
