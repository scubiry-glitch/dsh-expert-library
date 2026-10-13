import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewPublicUrl } from '../src/review-link.ts'

test('human gate links preserve target identity without an approval credential', () => {
  const url = new URL(reviewPublicUrl('https://example.test', { captainSessionId: 'captain-1', teamId: '上海研究', planId: 'plan-1', gate: 'outline', taskId: 't5' }))
  assert.equal(url.origin, 'https://example.test')
  assert.equal(url.searchParams.get('team'), '上海研究')
  assert.equal(url.searchParams.get('gate'), 'outline')
  assert.equal(url.searchParams.get('task'), 't5')
  assert.deepEqual([...url.searchParams.keys()], ['captain', 'plan', 'team', 'gate', 'task'])
  assert.equal(url.hash, '')
})

test('rejects credential-bearing and nonpublic origins; permits explicit loopback development', () => {
  const target = { captainSessionId: 'c', planId: 'p', gate: 'plan' }
  for (const origin of [undefined, '', 'javascript:alert(1)', 'http://example.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test/?token=secret', 'https://example.test/#secret']) {
    assert.equal(reviewPublicUrl(origin, target), undefined)
  }
  assert.ok(reviewPublicUrl('http://127.0.0.1:3000', target))
})
