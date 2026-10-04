import test from 'node:test'
import assert from 'node:assert/strict'
import { absoluteMemberMaxDepth } from '../lib/members.js'

test('member relative depth zero still allows the captain first child', () => {
  assert.equal(absoluteMemberMaxDepth(0, 0), 1)
  assert.equal(absoluteMemberMaxDepth(2, 0), 3)
})

test('member depth budget adds only the requested relative delegation levels', () => {
  assert.equal(absoluteMemberMaxDepth(1, 2), 4)
  assert.equal(absoluteMemberMaxDepth(0, undefined, 1), 2)
})

test('member depth translation rejects invalid budgets', () => {
  assert.throws(() => absoluteMemberMaxDepth(-1, 0), /non-negative/)
  assert.throws(() => absoluteMemberMaxDepth(0, -1), /non-negative/)
})
