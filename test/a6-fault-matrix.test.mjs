import test from 'node:test'
import assert from 'node:assert/strict'
import { runFaultMatrix } from '../scripts/qa/a6-fault-matrix.mjs'

test('A6 fault matrix passes every hermetic case', async () => {
  const summary = await runFaultMatrix()
  assert.equal(summary.kind, 'a6-fault-matrix')
  assert.equal(summary.cases.length, 9)
  assert.equal(summary.passed, summary.cases.length)
  assert.ok(summary.cases.every(item => item.passed === true))
})
