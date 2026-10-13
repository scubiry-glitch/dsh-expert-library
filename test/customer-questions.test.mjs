import test from 'node:test'
import assert from 'node:assert/strict'
import { CustomerQuestionHub } from '../src/host/customer-questions.ts'

test('question answer stays in its session and resumes the waiting turn', async () => {
  const hub = new CustomerQuestionHub()
  const questions = [{ id: 'scope', question: '研究哪个范围？', options: [
    { label: '贵阳' }, { label: '全省' }], multiSelect: false }]
  const waiting = hub.ask('session-a', questions)
  const card = hub.read('session-a')
  assert.ok(card?.requestId)
  assert.equal(hub.read('session-b'), null)
  assert.equal(hub.answer('session-b', card.requestId, [{ id: 'scope', selected: ['贵阳'] }]), false)
  assert.equal(hub.answer('session-a', card.requestId, [{ id: 'scope', selected: ['未知'] }]), false)
  assert.equal(hub.answer('session-a', card.requestId, [{ id: 'scope', selected: ['贵阳', '全省'] }]), false)
  assert.equal(hub.answer('session-a', card.requestId, [{ id: 'scope', selected: [], custom: '六盘水' }]), true)
  assert.deepEqual(await waiting, { answers: [{ id: 'scope', selected: [], custom: '六盘水' }] })
  assert.equal(hub.read('session-a'), null)
  assert.equal(hub.answer('session-a', card.requestId, [{ id: 'scope', selected: ['贵阳'] }]), false)
})

test('aborted question is removed and cannot receive a stale answer', async () => {
  const hub = new CustomerQuestionHub()
  const controller = new AbortController()
  const waiting = hub.ask('session-a', [{ id: 'source', question: '选数据源', options: [], multiSelect: false }], controller.signal)
  const card = hub.read('session-a')
  controller.abort()
  await assert.rejects(waiting, /QUESTION_ABORTED/)
  assert.equal(hub.read('session-a'), null)
  assert.equal(hub.answer('session-a', card.requestId, [{ id: 'source', selected: [], custom: '智见' }]), false)
})
