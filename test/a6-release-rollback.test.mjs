import test from 'node:test'
import assert from 'node:assert/strict'
import { runReleaseRollback } from '../scripts/qa/a6-release-rollback.mjs'

test('A6 release staging rejects a bad candidate and restores the backup', async () => {
  const summary = await runReleaseRollback()
  assert.equal(summary.kind, 'a6-release-rollback')
  assert.equal(summary.productionRootUntouched, true)
  assert.equal(summary.passed, summary.cases.length)
  assert.ok(['PASS', 'BLOCKED'].includes(summary.hostInstall.status))
  if (summary.hostInstall.status === 'BLOCKED') assert.match(summary.hostInstall.reason, /dsh|unavailable|not claimed/iu)
  assert.equal(summary.hostWeb.status, 'BLOCKED')
  if (summary.hostInstall.status === 'PASS') {
    assert.ok(summary.cases.some(item => item.id === 'isolated-candidate-install'))
    assert.ok(summary.cases.some(item => item.id === 'old-package-rollback'))
  }
})
