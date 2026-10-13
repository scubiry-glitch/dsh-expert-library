import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'
import { createReviewEventHub } from '../src/host/review-event-hub.ts'

function setup() {
  const handlers = new Map(), cleanup = []
  const subscribe = createReviewEventHub({
    on(name, callback, options) { assert.equal(options.global, true); assert(!handlers.has(name)); handlers.set(name, callback) },
    effect(factory) { cleanup.push(factory()) },
  })
  const events = []
  const leave = subscribe('captain', e => events.push(e))
  const frame = f => handlers.get('agent/assistant-stream')({ agent: { session: { id: 'captain', header: { origin: 'user' } } }, frame: { attemptId: 'a', ...f } })
  return { handlers, subscribe, events, frame, leave, close: () => cleanup.forEach(f => f()) }
}

test('one global subscription fans out only safe bound captain messages and isolates consumers', () => {
  const h = setup(), second = []
  h.subscribe('captain', e => second.push(e))
  h.subscribe('captain', e => { if (e.type === 'conversation') throw Error('broken browser') })
  const emit = h.handlers.get('session/event')
  emit({ id: 'other' }, { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'private' }] } } })
  emit({ id: 'captain' }, { seq: 2, type: 'tool/result', data: { content: [{ type: 'text', text: 'tool output' }] } })
  emit({ id: 'captain' }, { seq: 3, type: 'assistant/message', data: { message: { id: 'a3', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '答复' }] } } })
  assert.deepEqual(h.events, second)
  assert.deepEqual(h.events.filter(e => e.type === 'conversation'), [{ type: 'conversation', message: { id: 'a3', seq: 3, role: 'assistant', text: '答复' } }])
  h.leave(); const length = h.events.length
  emit({ id: 'captain' }, { seq: 4, type: 'turn/end' })
  assert.equal(h.events.length, length)
  h.close()
})

test('assistant previews batch text, replace finalized blocks, omit reasoning and recover mid-stream', async () => {
  const h = setup()
  h.frame({ type: 'start', revision: 1 })
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: 'SECRET' },
    { type: 'text-delta', index: 1, text: '你' },
    { type: 'text-delta', index: 1, text: '好' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '你好！' } },
    { type: 'tool-call-delta', index: 2, argumentsDelta: 'PRIVATE' },
  ]
  chunks.forEach((chunk, index) => h.frame({ type: 'chunk', revision: index + 2, index, chunk }))
  await wait(190)
  assert.deepEqual(h.events.filter(e => e.value?.text), [{ type: 'assistant', value: { attemptId: 'a', text: '你好！' } }])
  const resumed = []; h.subscribe('captain', e => resumed.push(e))
  assert.equal(resumed[0].value.text, '你好！')
  assert(!JSON.stringify(h.events).includes('SECRET')); assert(!JSON.stringify(h.events).includes('PRIVATE'))
  h.frame({ type: 'end', revision: 7, index: 5 })
  assert.equal(h.events.at(-1).value, null)
  h.close()
})

test('gapped or disposed attempts are cleared, children never enter a captain preview', () => {
  const h = setup()
  h.frame({ type: 'start', revision: 1 })
  h.frame({ type: 'chunk', revision: 3, index: 1, chunk: { type: 'text-delta', index: 0, text: 'incomplete' } })
  const resumed = []; h.subscribe('captain', e => resumed.push(e))
  assert.equal(resumed[0].value, null)
  h.handlers.get('agent/assistant-stream')({ agent: { session: { id: 'captain', header: { origin: 'subagent' } } }, frame: { type: 'start', revision: 1, attemptId: 'child' } })
  h.handlers.get('agent/disposed')({ agent: { session: { id: 'captain' } } })
  h.close()
  assert.equal(h.events.at(-1).type, 'close')
})
