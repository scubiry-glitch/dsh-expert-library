import test from 'node:test'
import assert from 'node:assert/strict'
import { runSecurityCompat } from '../scripts/qa/a6-security-compat.mjs'

test('A6 security and compatibility matrix is fail-closed', async () => {
  const summary = await runSecurityCompat()
  assert.equal(summary.kind, 'a6-security-compat')
  assert.equal(summary.secretsUsed, false)
  assert.equal(summary.sentinelInputsUsed, true)
  assert.equal(summary.passed, summary.cases.length)
  assert.ok(summary.cases.length >= 6)
})
